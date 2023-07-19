let Nimiq;
try {
    Nimiq = require('../../dist/node.js');
} catch (e) {
    Nimiq = require('@nimiq/core');
}
const fetch = require("node-fetch");
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
 * Abstract Class NimiqInterface.
 *
 * @class NimiqInterface
 */
class NimiqInterface {
    constructor() {
        if (this.constructor == NimiqInterface) {
            throw new Error("Nimiq Interface is an abstract class and can't be instantiated");
        }
    }
    /**
     * @param {Address|string} address Address of an account
     * @param {number} [sinceBlockHeight=0] Minimum block height to consider for updates
     * @return {Promise.<Array.<Object>>}
     */
    async getTransactionsByAddress(address, sinceBlockHeight = 0) {
        throw new Error("Method 'getTransactionsByAddress' must be implemented.");
    }

    /**
    * @param {Hash} blockHash Hash of a block
    * @param {string} startPrefix The start prefix for the chunk
    * @returns {Promise.<?Object>}
    */
    async getAccountsTreeChunk(blockHash, startPrefix) {
        throw new Error("Method 'getAccountsTreeChunk' must be implemented.");
    }

    /**
    * @param {Hash} blockHash Hash of a block
    * @returns {Promise.<?Object>}
    */
    async getBlock(blockHash) {
        throw new Error("Method 'getBlock' must be implemented.");
    }
}

/**
 * An implementation of the NimiqInterface using a full client as library
 */
class FullBlockchainInterface extends NimiqInterface {
    /**
     * @param {FullChain} blockchain Full blockchain.
     * @param {Client} client Nimiq client.
     * @returns {FullBlockchainInterface}
    */
    constructor(blockchain, client) {
        super();
        this._client = client;
        this._blockchain = blockchain;
    }

    /**
     * @param {Account} account
     * @param {Address} address
     * @returns {object}
     * @private
     */
    _accountToObj(account, address) {
        if (!account) return null;
        const obj = {
            id: address.toHex(),
            address: address.toUserFriendlyAddress(),
            balance: account.balance,
            type: account.type
        };
        if (account instanceof Nimiq.VestingContract) {
            obj.owner = account.owner.toHex();
            obj.ownerAddress = account.owner.toUserFriendlyAddress();
            obj.vestingStart = account.vestingStart;
            obj.vestingStepBlocks = account.vestingStepBlocks;
            obj.vestingStepAmount = account.vestingStepAmount;
            obj.vestingTotalAmount = account.vestingTotalAmount;
        } else if (account instanceof Nimiq.HashedTimeLockedContract) {
            obj.sender = account.sender.toHex();
            obj.senderAddress = account.sender.toUserFriendlyAddress();
            obj.recipient = account.recipient.toHex();
            obj.recipientAddress = account.recipient.toUserFriendlyAddress();
            obj.hashRoot = account.hashRoot.toHex();
            obj.hashAlgorithm = account.hashRoot.algorithm;
            obj.hashCount = account.hashCount;
            obj.timeout = account.timeout;
            obj.totalAmount = account.totalAmount;
        }
        return obj;
    }

    /**
     * @param {AccountsTreeNode} node
     * @returns {object}
     * @private
     */
    _accountsTreeNodeObj(node) {
        return {
            prefix: node.prefix,
            account: this._accountToObj(node.account, Nimiq.Address.fromString(node.prefix))
        }
    }

    /**
     * @param {AccountsTreeChunk} chunk
     * @returns {object}
     * @private
     */
    _accountsTreeChunkToObj(chunk) {
        return {
            nodes: chunk.terminalNodes.filter((node) => node.isTerminal()).map((node) => this._accountsTreeNodeObj(node)),
            proof: chunk.proof.toString(),
            length: chunk.length,
            tail: chunk.tail.prefix,
        };
    }

    /**
     * @param {Block} block
     * @param {boolean} [includeTransactions]
     * @private
     */
    async _blockToObj(block, includeTransactions = false) {
        const obj = {
            number: block.height,
            hash: block.hash().toHex(),
            pow: (await block.pow()).toHex(),
            parentHash: block.prevHash.toHex(),
            nonce: block.nonce,
            bodyHash: block.bodyHash.toHex(),
            accountsHash: block.accountsHash.toHex(),
            difficulty: block.difficulty,
            timestamp: block.timestamp,
            confirmations: (await this._client.getHeadHeight()) - block.height + 1
        };
        if (block.isFull()) {
            obj.miner = block.minerAddr.toHex();
            obj.minerAddress = block.minerAddr.toUserFriendlyAddress();
            obj.extraData = Nimiq.BufferUtils.toHex(block.body.extraData);
            obj.size = block.serializedSize;
            obj.transactions = includeTransactions
                ? await Promise.all(block.transactions.map((tx, i) => this._transactionToObj(tx, block, i)))
                : block.transactions.map((tx) => tx.hash().toHex());
        }
        return obj;
    }

    /**
     * @param {Transaction} tx
     * @param {Block} [block]
     * @param {number} [i]
     * @private
     */
    async _transactionToObj(tx, block, i) {
        return {
            hash: tx.hash().toHex(),
            blockHash: block ? block.hash().toHex() : undefined,
            blockNumber: block ? block.height : undefined,
            timestamp: block ? block.timestamp : undefined,
            confirmations: block ? (await this._client.getHeadHeight()) - block.height + 1 : 0,
            transactionIndex: i,
            from: tx.sender.toHex(),
            fromAddress: tx.sender.toUserFriendlyAddress(),
            to: tx.recipient.toHex(),
            toAddress: tx.recipient.toUserFriendlyAddress(),
            value: tx.value,
            fee: tx.fee,
            data: Nimiq.BufferUtils.toHex(tx.data) || null,
            flags: tx.flags
        };
    }

    /**
     * @param {Client.TransactionDetails} tx
     * @private
     */
    _transactionDetailsToObj(tx) {
        return {
            hash: tx.transactionHash.toHex(),
            blockHash: tx.blockHash ? tx.blockHash.toHex() : undefined,
            blockNumber: tx.blockHeight,
            timestamp: tx.timestamp,
            confirmations: tx.confirmations,
            from: tx.sender.toHex(),
            fromAddress: tx.sender.toUserFriendlyAddress(),
            to: tx.recipient.toHex(),
            toAddress: tx.recipient.toUserFriendlyAddress(),
            value: tx.value,
            fee: tx.fee,
            data: Nimiq.BufferUtils.toHex(tx.data.raw) || null,
            proof: Nimiq.BufferUtils.toHex(tx.proof.raw) || null,
            flags: tx.flags
        };
    }

    /**
     * @param {Address|string} address Address of an account
     * @param {number} [sinceBlockHeight=0] Minimum block height to consider for updates
     * @return {Promise.<Array.<Object>>}
     */
    async getTransactionsByAddress(address, sinceBlockHeight = 0) {
        const txs = await this._client.getTransactionsByAddress(Nimiq.Address.fromUserFriendlyAddress(address), sinceBlockHeight);
        return txs.map((tx) => this._transactionDetailsToObj(tx));
    }

    /**
    * @param {string} blockHash Hash of a block
    * @param {string} startPrefix The start prefix for the chunk
    * @returns {Promise.<?Object>}
    */
    async getAccountsTreeChunk(blockHash, startPrefix) {
        const chunk = await this._blockchain.getAccountsTreeChunk(Nimiq.Hash.fromString(blockHash), startPrefix, null);
        return this._accountsTreeChunkToObj(chunk);
    }

    /**
    * @param {string} blockHash Hash of a block
    * @returns {Promise.<?Object>}
    */
    async getBlock(blockHash) {
        const block = await this._blockchain.getBlock(Nimiq.Hash.fromString(blockHash));
        return this._blockToObj(block);
    }
}

/**
 * An implementation of the NimiqInterface using RPC
 */
class RpcInterface extends NimiqInterface {
    /**
     * @param {string} url RPC URL.
     * @returns {RpcInterface}
    */
    constructor(url) {
        super();
        this._url = url;
    }

    rpc_fetch(method, ...params) {
        while (params.length > 0 && typeof params[params.length - 1] === 'undefined') params.pop();
        RpcInterface._currentMessageId = (RpcInterface._currentMessageId || 0) + 1;
        const jsonrpc = JSON.stringify({
            jsonrpc: '2.0',
            id: RpcInterface._currentMessageId,
            method: method,
            params: params
        });

        return fetch(`${this._url}`, {
            method: 'POST',
            body: jsonrpc
        }).then(response => {
            if (response.status === 401) {
                throw new Error('Connection Failed: Authentication Required.');
            }
            if (response.status !== 200) {
                throw new Error(`Connection Failed. ${response.statusText ? response.statusText
                    : `Error Code: ${response.status}`}`);
            }

            return response.json();
        }).then(data => {
            if (data.error) {
                throw new Error(`A RPC Error Occurred: ${data.error.message}`);
            }
            return data.result;
        });
    }

    /**
     * @param {Address|string} address Address of an account
     * @param {number} [sinceBlockHeight=0] Minimum block height to consider for updates
     * @return {Promise.<Array.<Object>>}
     */
    async getTransactionsByAddress(address, sinceBlockHeight = 0) {
        return this.rpc_fetch('getTransactionsByAddress', address, 100000000);
    }

    /**
    * @param {Hash} blockHash Hash of a block
    * @param {string} startPrefix The start prefix for the chunk
    * @returns {Promise.<Object>}
    */
    async getAccountsTreeChunk(blockHash, startPrefix) {
        return this.rpc_fetch('getAccountsTreeChunk', blockHash, startPrefix);
    }

    /**
    * @param {string} blockHash Hash of a block
    * @returns {Promise.<Object>}
    */
    async getBlock(blockHash) {
        return this.rpc_fetch('getBlockByHash', blockHash);
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
        const group = (groups[txn.fromAddress] || []);
        group.push(txn);
        groups[txn.fromAddress] = group;
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
            const tx = item;
            const blockHeight = item.blockNumber;
            if (!tx.data || tx.data.length < 64 * 2) {
                continue;
            }
            const buf = new Nimiq.SerialBuffer(Nimiq.BufferUtils.fromHex(tx.data));
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
            const tx = item;
            const blockHeight = item.blockNumber;
            if (tx.value < VALIDATOR_DEPOSIT || !tx.data || tx.data.length < 36 * 2) {
                continue;
            }
            let data = Nimiq.BufferUtils.toAscii(Nimiq.BufferUtils.fromHex(tx.data));
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
    for (const accountTreeNode of accountsTreeChunk.nodes) {
        var endOfLine = require('os').EOL;
        account_data = accountTreeNode.account;
        account_prefix = accountTreeNode.prefix;
        address_friendly = Nimiq.Address.fromAny(account_prefix).toUserFriendlyAddress();
        if (account_data.type === Nimiq.Account.Type.BASIC) {
            fileStream.write("[[basic_accounts]]");
            fileStream.write(endOfLine);
            fileStream.write(`address = "${address_friendly}"`);
            fileStream.write(endOfLine);
            fileStream.write(`balance = ${account_data.balance}`);
            fileStream.write(endOfLine);
            fileStream.write(endOfLine);
        }
        if (account_data.type === Nimiq.Account.Type.VESTING) {
            fileStream.write("[[vesting_accounts]]");
            fileStream.write(endOfLine);
            fileStream.write(`address = "${address_friendly}"`);
            fileStream.write(endOfLine);
            fileStream.write(`balance = ${account_data.balance}`);
            fileStream.write(endOfLine);
            fileStream.write(`owner = "${account_data.ownerAddress}"`);
            fileStream.write(endOfLine);
            let vestingStartTS;
            if (account_data.vestingStart <= block.number) {
                vestingStartTS = block.timestamp;
            } else {
                vestingStartTS = (account_data.vestingStart - block.number) * BLOCK_TIME_MS + albatrossTs;
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

        if (account_data.type === Nimiq.Account.Type.HTLC) {
            fileStream.write("[[htlc_accounts]]");
            fileStream.write(endOfLine);
            fileStream.write(`address = "${address_friendly}"`);
            fileStream.write(endOfLine);
            fileStream.write(`balance = ${account_data.balance}`);
            fileStream.write(endOfLine);
            fileStream.write(`sender = "${account_data.senderAddress}"`);
            fileStream.write(endOfLine);
            fileStream.write(`hash_root = { hash = "${account_data.hashRoot}", algorithm = "${Nimiq.Hash.Algorithm.toString(account_data.hashAlgorithm)}" }`);
            fileStream.write(endOfLine);
            fileStream.write(`recipient = "${account_data.recipientAddress}"`);
            fileStream.write(endOfLine);
            fileStream.write(`hash_count = ${account_data.hashCount}`);
            fileStream.write(endOfLine);
            let htlcTimeoutTS;
            if (account_data.timeout <= block.number) {
                htlcTimeoutTS = block.timestamp;
            } else {
                htlcTimeoutTS = (account_data.timeout - block.number) * BLOCK_TIME_MS + albatrossTs;
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
    let headBlockHeight = block.number;
    let headBlockTs = block.timestamp;
    let blockHash = block.hash;
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
 * @param {NimiqInterface} interface Nimiq interface to get the required data.
 * @param {Block} block Block up until the state will be dumped.
 * @param {string} vrfSeed VRF seed of the PoS genesis block.
 */
async function dumpChainState(fileName, customGenesisDelay, interface, block, vrfSeed) {
    var fs = require('fs')
    var fileStream = fs.createWriteStream(fileName);

    // Dump the head block info
    const albatrossTs = await dump_head_block_data(fileStream, block, customGenesisDelay, vrfSeed);

    // Dump the Accounts tree in chunks
    let actualChunksize = 0;
    let startAddress = '';

    do {
        accountsTreeChunk = await interface.getAccountsTreeChunk(block.hash, startAddress);
        actualChunksize = accountsTreeChunk.length - 1;
        if (actualChunksize != 0) {
            console.log(`Processing chunk of size: ${actualChunksize}`);
            startAddress = accountsTreeChunk.tail;
            await dumpAccountsToToml(accountsTreeChunk, block, albatrossTs, fileStream);
        }
    } while (actualChunksize != 0)

    transactions = await interface.getTransactionsByAddress(BURN_ADDRESS);
    transactions.filter((txn) => { txn.blockNumber <= block.number });

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
                $.network.disconnect("Already synced and no need to sync more blocks");
                const interface = new FullBlockchainInterface($.blockchain, $.client);
                const block = await interface.getBlock(blockHash);
                if (block.number != blockHeight) {
                    console.log(`${block.blockNumber} vs ${blockHeight}`)
                    console.error("Could not get block hash at specified block height");
                    process.exit(1);
                }
                await dumpChainState(fileName, customGenesisDelay, new FullBlockchainInterface($.blockchain, $.client), block, vrfSeed);
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
    --hash   BLOCK_HASH   Block hash of the block up to the information is going to be queried.
    --height BLOCK_NUMBER Block number of the block up to the information is going to be queried.
    --vrf    VRF_SEED     Nimiq PoS genesis VRF seed.
    --rpc    RPC_URL      RPC URL to use.
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
        if (argv.rpc) {
            // Use RPC to dump the state
            const interface = new RpcInterface(argv.rpc);
            const block = await interface.getBlock(argv.hash);
            if (block.number != argv.height) {
                console.error(`No block found with specified hash and height`);
                process.exit(1);
            }
            await dumpChainState(outputFileName, argv.genesisdelay * 60 * 1000, interface, block, argv.vrf);
        } else {
            // Instantiate a full client and dump its state
            await initNimiqClient(outputFileName, argv.genesisdelay * 60 * 1000, argv.hash, argv.height, argv.vrf);
        }
        rl.close();
    } catch (e) {
        console.error(e.message || e.msg || e);
        rl.close();
    }
})();
