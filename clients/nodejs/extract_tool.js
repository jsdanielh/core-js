let Nimiq;
try {
    Nimiq = require('../../dist/node.js');
} catch (e) {
    Nimiq = require('@nimiq/core');
}
const endOfLine = require('os').EOL;
const readline = require('readline');
const stream = require('stream');
const util = require('util');
const argv = require('minimist')(process.argv.slice(2));
const BLOCK_TIME_MS = 60 * 1000;
const START = Date.now();
const config = require('./modules/Config.js')(argv);
const TAG = 'Node';
const BURN_ADDRESS = 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000';
const VALIDATOR_DEPOSIT = 10;
const $ = {};
const finished = util.promisify(stream.finished); // (A)

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
});

config.protocol = 'dumb'
if (config.type != 'full') {
    console.error('The extract tool requires a full node');
    process.exit(1);
}
//config.network = "test";

Nimiq.Log.instance.level = config.log.level;
for (const tag in config.log.tags) {
    Nimiq.Log.instance.setLoggable(tag, config.log.tags[tag]);
}

for (const key in config.constantOverrides) {
    Nimiq.ConstantHelper.instance.set(key, config.constantOverrides[key]);
}

for (const seedPeer of config.seedPeers) {
    if (!seedPeer.host || !seedPeer.port) {
        console.error('Seed peers must have host and port attributes set');
        process.exit(1);
    }
}

/**
 * Dumps the validators registered in the 1.0 chain into a file for the PoS genesis block.
 * @param {fs.WriteStream>} fileStream Filestream where the 1.0 state will be dumped to.
 * @param {Array<TransactionDetails>} transactions Array of transaction that were sent to the 1.0 burn address.
 */
async function dumpValidators(fileStream, transactions) {
    const possibleValidators = new Map();
    // Group transaction objects by their sender
    const txnsBySender = transactions.reduce((groups, txn) => {
        const group = (groups[txn.transaction.sender] || []);
        group.push(txn);
        groups[txn.transaction.sender] = group;
        return groups;
    }, {});
    // First look for the 6 transactions that carries the validator data
    for (const [sender, txns] of Object.entries(txnsBySender)) {
        let signingKey;
        let address;
        let votingKey = new Array(5);
        const txnBlockHeight = new Array(0, 0, 0, 0, 0, 0, 0);
        let txns_parsed = 0;
        for (const item of txns) {
            const tx = item.transaction;
            const blockHeight = item.blockHeight;
            const buf = new Nimiq.SerialBuffer(tx.data);
            if (tx.data.length < 64) {
                continue;
            }
            const first_byte = buf.readUint8();
            switch (first_byte) {
                case 1:
                    if (txnBlockHeight[0] > blockHeight) {
                        continue;
                    }
                    buf.read(11); // Unused
                    signingKey = Nimiq.PublicKey.unserialize(buf); // Signing key
                    address = Nimiq.Address.unserialize(buf);
                    txns_parsed += 1;
                    txnBlockHeight[0] = blockHeight;
                    break;
                case 2:
                    if (txnBlockHeight[1] > blockHeight) {
                        continue;
                    }
                    buf.read(6); // Unused
                    votingKey[0] = Nimiq.BufferUtils.toHex(buf.read(57));
                    txns_parsed += 1;
                    txnBlockHeight[1] = blockHeight;
                    break;
                case 3:
                    if (txnBlockHeight[2] > blockHeight) {
                        continue;
                    }
                    buf.read(6); // Unused
                    votingKey[1] = Nimiq.BufferUtils.toHex(buf.read(57));
                    txns_parsed += 1;
                    txnBlockHeight[2] = blockHeight;
                    break;
                case 4:
                    if (txnBlockHeight[3] > blockHeight) {
                        continue;
                    }
                    buf.read(6); // Unused
                    votingKey[2] = Nimiq.BufferUtils.toHex(buf.read(57));
                    txns_parsed += 1;
                    txnBlockHeight[3] = blockHeight;
                    break;
                case 5:
                    if (txnBlockHeight[4] > blockHeight) {
                        continue;
                    }
                    buf.read(6); // Unused
                    votingKey[3] = Nimiq.BufferUtils.toHex(buf.read(57));
                    txns_parsed += 1;
                    txnBlockHeight[4] = blockHeight;
                    break;
                case 6:
                    if (txnBlockHeight[5] > blockHeight) {
                        continue;
                    }
                    buf.read(6); // Unused
                    votingKey[4] = Nimiq.BufferUtils.toHex(buf.read(57));
                    txns_parsed += 1;
                    txnBlockHeight[5] = blockHeight;
                    break;
                default:
            }
        }
        if (txns_parsed == 6) {
            possibleValidators.set(address.toUserFriendlyAddress(), { address: address, signingKey: signingKey, votingKey: votingKey.join('') });
            console.log(`Found possible validator "${address.toUserFriendlyAddress()}"`);
        }
    }
    // Now look for the commit transaction
    for (const [sender, txns] of Object.entries(txnsBySender)) {
        for (const item of txns) {
            const tx = item.transaction;
            const blockHeight = item.blockHeight;
            if (tx.value < VALIDATOR_DEPOSIT || tx.data.length < 36) {
                continue;
            }
            let data = Nimiq.BufferUtils.toAscii(tx.data);
            if (possibleValidators.has(data)) {
                const validator = possibleValidators.get(data);
                possibleValidators.delete(data);
                console.log(`Found commit transaction for validator "${validator.address.toUserFriendlyAddress()}"`);
                fileStream.write("[[validator]]");
                fileStream.write(endOfLine);
                fileStream.write(`address = "${validator.address.toUserFriendlyAddress()}"`);
                fileStream.write(endOfLine);
                fileStream.write(`signing_key = "${validator.signingKey.toHex()}"`);
                fileStream.write(endOfLine);
                fileStream.write(`voting_key = "${validator.votingKey}"`);
                fileStream.write(endOfLine);
                fileStream.write(`reward_address = "${validator.address.toUserFriendlyAddress()}"`);
                fileStream.write(endOfLine);
                fileStream.write(endOfLine);
            }
        }
    }
}

/**
 * Dumps the state of the 1.0 chain into a file in the PoS genesis block TOML format.
 * @param {<Array.<AccountsTreeNode>>} accountsTreeChunk The accounts tree of the 1.0 chain.
 * @param {Block} block Block up until the state will be dumped.
 * @param {number} albatrossTs Timestamp of the PoS genesis block.
 * @param {fs.WriteStream>} fileStream Filestream where the 1.0 state will be dumped to.
 */
async function dumpAccountsToToml(accountsTreeChunk, block, albatrossTs, fileStream) {
    for (const accountTreeNode of accountsTreeChunk.terminalNodes) {
        var endOfLine = require('os').EOL;
        account = accountTreeNode.account;
        account_prefix = accountTreeNode.prefix;
        address_friendly = Nimiq.Address.fromAny(account_prefix).toUserFriendlyAddress();
        if (account.type === Nimiq.Account.Type.BASIC) {
            account_data = account.toPlain();
            fileStream.write("[[basic_accounts]]");
            fileStream.write(endOfLine);
            fileStream.write(`address = "${address_friendly}"`);
            fileStream.write(endOfLine);
            fileStream.write(`balance = ${account_data.balance}`);
            fileStream.write(endOfLine);
            fileStream.write(endOfLine);
        }
        if (account.type === Nimiq.Account.Type.VESTING) {
            account_data = account.toPlain();
            fileStream.write("[[vesting_accounts]]");
            fileStream.write(endOfLine);
            fileStream.write(`address = "${address_friendly}"`);
            fileStream.write(endOfLine);
            fileStream.write(`balance = ${account_data.balance}`);
            fileStream.write(endOfLine);
            fileStream.write(`owner = "${account_data.owner}"`);
            fileStream.write(endOfLine);
            let vestingStartTS;
            if (account_data.vestingStart <= block.height) {
                vestingStartTS = block.timestamp;
            } else {
                vestingStartTS = (account_data.vestingStart - block.height) * BLOCK_TIME_MS + albatrossTs;
            }
            fileStream.write(`start_time = ${vestingStartTS}`);
            fileStream.write(endOfLine);
            fileStream.write(`time_step = ${account_data.vestingStepBlocks}`);
            fileStream.write(endOfLine);
            fileStream.write(`step_amount = ${account_data.vestingStepAmount}`);
            fileStream.write(endOfLine);
            fileStream.write(`total_amount = ${account_data.vestingTotalAmount}`);
            fileStream.write(endOfLine);
            fileStream.write(endOfLine);
        }

        if (account.type === Nimiq.Account.Type.HTLC) {
            account_data = account.toPlain();
            fileStream.write("[[htlc_accounts]]");
            fileStream.write(endOfLine);
            fileStream.write(`address = "${address_friendly}"`);
            fileStream.write(endOfLine);
            fileStream.write(`balance = ${account_data.balance}`);
            fileStream.write(endOfLine);
            fileStream.write(`sender = "${account_data.sender}"`);
            fileStream.write(endOfLine);
            fileStream.write(`hash_root = { hash = "${account_data.hashRoot}", algorithm = "${account_data.hashAlgorithm}" }`);
            fileStream.write(endOfLine);
            fileStream.write(`recipient = "${account_data.recipient}"`);
            fileStream.write(endOfLine);
            fileStream.write(`hash_count = ${account_data.hashCount}`);
            fileStream.write(endOfLine);
            let htlcTimeoutTS;
            if (account_data.timeout <= block.height) {
                htlcTimeoutTS = block.timestamp;
            } else {
                htlcTimeoutTS = (account_data.timeout - block.height) * BLOCK_TIME_MS + albatrossTs;
            }
            fileStream.write(`timeout = ${htlcTimeoutTS}`);
            fileStream.write(endOfLine);
            fileStream.write(`total_amount = ${account_data.totalAmount}`);
            fileStream.write(endOfLine);
            fileStream.write(endOfLine);
        }

    }
}

/**
 * Dumps the head data of the PoS genesis block.
 * @param {string} fileName The file name where the chain state will be dumped.
 * @param {Block} block Block up until the state will be dumped.
 * @param {number} customGenesisDelay Genesis delay to be added to the 1.0 block timestamp for building the PoS genesis block.
 * @param {string} vrfSeed VRF seed of the PoS genesis block.
 * @returns {Promise.<number>}
 */
async function dump_head_block_data(fileStream, block, customGenesisDelay, vrfSeed) {
    let headBlockHeight = block.height;
    let headBlockTs = block.timestamp;
    let blockHash = block.hash().toPlain();
    const date = new Date();
    const albatrossTs = headBlockTs + customGenesisDelay;
    const albatrossDate = new Date(albatrossTs);
    fileStream.write("# Generated file from Nimiq 1.0 blockchain state");
    fileStream.write(endOfLine);
    fileStream.write(`# File generated @${date}`);
    fileStream.write(endOfLine);
    fileStream.write("# Nimiq 1.0 state at snapshot:");
    fileStream.write(endOfLine);
    fileStream.write(`# - Block hash: ${blockHash}`);
    fileStream.write(endOfLine);
    fileStream.write(`# - Block height: ${headBlockHeight}`);
    fileStream.write(endOfLine);
    fileStream.write(`# - Block timestamp = ${headBlockTs}`);
    fileStream.write(endOfLine);
    fileStream.write(`# Nimiq PoS genesis delay = ${customGenesisDelay}`);
    fileStream.write(endOfLine);
    fileStream.write(endOfLine);
    fileStream.write(`name = "test-albatross"`);
    fileStream.write(endOfLine);
    fileStream.write(`seed_message = "Albatross TestNet"`);
    fileStream.write(endOfLine);
    fileStream.write(`timestamp = "${albatrossDate.toISOString()}"`);
    fileStream.write(endOfLine);
    fileStream.write(`vrf_seed = "${vrfSeed}"`);
    fileStream.write(endOfLine);
    fileStream.write(endOfLine);

    return albatrossTs;
}

/**
 * Dumps the state of the 1.0 chain into a file in the PoS genesis block TOML format.
 * @param {string} fileName The file name where the chain state will be dumped.
 * @param {number} customGenesisDelay Genesis delay to be added to the 1.0 block timestamp for building the PoS genesis block.
 * @param {FullChain} blockchain Full blockchain.
 * @param {Client} client Nimiq client.
 * @param {Block} block Block up until the state will be dumped.
 * @param {string} vrfSeed VRF seed of the PoS genesis block.
 */
async function dumpChainState(fileName, customGenesisDelay, blockchain, client, block, vrfSeed) {
    var fs = require('fs')
    var fileStream = fs.createWriteStream(fileName);

    // Dump the head block info
    const albatrossTs = await dump_head_block_data(fileStream, block, customGenesisDelay, vrfSeed);

    // Dump the Accounts tree in chunks
    let actualChunksize = 0;
    let startAddress = '';

    do {
        accountsTreeChunk = await blockchain.getAccountsTreeChunk(block.hash(), startAddress, null);
        actualChunksize = accountsTreeChunk.length - 1;
        if (actualChunksize != 0) {
            console.log(`Processing chunk of size: ${actualChunksize}`);
            startAddress = accountsTreeChunk.tail.prefix;
            await dumpAccountsToToml(accountsTreeChunk, block, albatrossTs, fileStream);
        }
    } while (actualChunksize != 0)

    transactions = await client.getTransactionsByAddress(Nimiq.Address.fromUserFriendlyAddress(BURN_ADDRESS));
    blockchain.getTransactionReceiptsByAddress(Nimiq.Address.fromUserFriendlyAddress(BURN_ADDRESS));
    transactions.filter((txn) => { txn.blockHeight <= block.height });

    await dumpValidators(fileStream, transactions, block);

    fileStream.end();
    await finished(fileStream);
}

/**
 * Initializes the Nimiq client, fetches the block specified and dumps the state of the
 * 1.0 chain into a file in the PoS genesis block TOML format.
 * @param {string} fileName The file name where the chain state will be dumped.
 * @param {number} customGenesisDelay Genesis delay to be added to the 1.0 block timestamp for building the PoS genesis block.
 * @param {string} blockHash Block hash up until which the state will be dumped.
 * @param {number} blockHeight Block height up until which the state will be dumped.
 * @param {string} vrfSeed VRF seed of the PoS genesis block.
 */
async function initNimiqClient(fileName, customGenesisDelay, blockHash, blockHeight, vrfSeed) {
    Nimiq.Log.i(TAG, `Nimiq NodeJS Client starting (network=${config.network}`
        + `, ${config.host ? `host=${config.host}, port=${config.port}` : 'dumb'}`);

    Nimiq.GenesisConfig.init(Nimiq.GenesisConfig.CONFIGS[config.network]);

    for (const seedPeer of config.seedPeers) {
        let address;
        switch (seedPeer.protocol) {
            case 'ws':
                address = Nimiq.WsPeerAddress.seed(seedPeer.host, seedPeer.port, seedPeer.publicKey);
                break;
            case 'wss':
            default:
                address = Nimiq.WssPeerAddress.seed(seedPeer.host, seedPeer.port, seedPeer.publicKey);
                break;
        }
        Nimiq.GenesisConfig.SEED_PEERS.push(address);
    }

    const clientConfigBuilder = Nimiq.Client.Configuration.builder();
    clientConfigBuilder.protocol(config.protocol, config.host, config.port, config.tls.key, config.tls.cert);
    if (config.reverseProxy.enabled) clientConfigBuilder.reverseProxy(config.reverseProxy.port, config.reverseProxy.header, ...config.reverseProxy.addresses);
    if (config.passive) clientConfigBuilder.feature(Nimiq.Client.Feature.PASSIVE);
    clientConfigBuilder.feature(Nimiq.Client.Feature.LOCAL_HISTORY);

    const clientConfig = clientConfigBuilder.build();
    const networkConfig = clientConfig.networkConfig;

    $.consensus = await Nimiq.Consensus.full(networkConfig);

    $.client = new Nimiq.Client(clientConfig, $.consensus);
    $.blockchain = $.consensus.blockchain;
    $.accounts = $.blockchain.accounts;
    $.mempool = $.consensus.mempool;
    $.network = $.consensus.network;

    Nimiq.Log.i(TAG, `Peer address: ${networkConfig.peerAddress.toString()} - public key: ${networkConfig.keyPair.publicKey.toHex()}`);

    const chainHeight = await $.client.getHeadHeight();
    const chainHeadHash = await $.client.getHeadHash();
    Nimiq.Log.i(TAG, `Blockchain state: height=${chainHeight}, headHash=${chainHeadHash}`);


    let consensusState = Nimiq.Client.ConsensusState.CONNECTING;
    $.client.addConsensusChangedListener(async (state) => {
        consensusState = state;
        if (state === Nimiq.Client.ConsensusState.ESTABLISHED) {
            Nimiq.Log.i(TAG, `Blockchain ${config.type}-consensus established in ${(Date.now() - START) / 1000}s.`);
            const chainHeight = await $.client.getHeadHeight();
            const chainHeadHash = await $.client.getHeadHash();
            Nimiq.Log.i(TAG, `Current state: height=${chainHeight}, headHash=${chainHeadHash}`);
            if (chainHeight >= blockHeight) {
                Nimiq.Log.i(TAG, `Disconnecting from network`);
                $.network.disconnect("Already synced and");
                block = await $.blockchain.getBlockAt(blockHeight);
                if (block.hash().toPlain() != blockHash) {
                    console.error("Could not get block hash at specified block height");
                    process.exit(1);
                }
                await dumpChainState(fileName, customGenesisDelay, $.blockchain, $.client, block, vrfSeed);
                process.exit(0);
            }
        }
    });


    $.client.addBlockListener(async (hash) => {
        if (consensusState === Nimiq.Client.ConsensusState.SYNCING) {
            const head = await $.client.getBlock(hash, false);
            if (head.height % 100 === 0) {
                Nimiq.Log.i(TAG, `Syncing at block: ${head.height}`);
            }
        }
    });


}

function help() {
    console.log(`Nimiq NodeJS tool to extract the accounts tree into a TOML file

Usage:
    node extract_tool.js <output-file-name> [options]

Description:
    output-file-name    TOML output file name

Options:
    --help                Display this help page
    --genesisdelay DELAY  Custom delay for the Nimiq PoS genesis in minutes. The default is 60 minutes.
    --hash BLOCK_HASH     Block hash of the block up to the information is going to be queried.
    --height BLOCK_NUMBER Block number of the block up to the information is going to be queried.
    --vrf    VRF_SEED     Nimiq PoS genesis VRF seed.
    `);
    rl.close();
}

(async () => {
    if (argv.help || argv._.length === 0) {
        return help();
    }
    argv.genesisdelay = argv.genesisdelay || 60;
    if (!argv.height) {
        console.error("Missing block height argument");
        return help();
    };
    if (!argv.hash) {
        console.error("Missing block hash argument");
        return help();
    };
    if (!argv.vrf) {
        console.error("Missing vrf argument");
        return help();
    };

    try {
        outputFileName = argv._[0];
        await initNimiqClient(outputFileName, argv.genesisdelay * 60 * 1000, argv.hash, argv.height, argv.vrf);
        rl.close();
    } catch (e) {
        console.error(e.message || e.msg || e);
        rl.close();
    }
})();
