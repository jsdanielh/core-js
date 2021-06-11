let Nimiq;
try {
    Nimiq = require('../../dist/node.js');
} catch (e) {
    Nimiq = require('@nimiq/core');
}
const readline = require('readline');
const argv = require('minimist')(process.argv.slice(2));

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
});

/**
 * @param {<Array.<AccountsTreeNode>>} accountsTreeChunk
 */
async function dumpAccountstoToml(accountsTreeChunk, chainDS, headBlockHeight, fileStream) {
    for (const accountTreeNode of accountsTreeChunk) {
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
            if (account_data.vestingStart <= headBlockHeight) {
                vestingStartBlock = await chainDS.getBlockAt(account_data.vestingStart);
                let vestingStartTS = vestingStartBlock.timestamp;
                fileStream.write(`vesting_start_ts = ${vestingStartTS}`);
                fileStream.write(endOfLine);
            }
            fileStream.write(`vesting_start = ${account_data.vestingStart}`);
            fileStream.write(endOfLine);
            fileStream.write(`vesting_step_blocks = ${account_data.vestingStepBlocks}`);
            fileStream.write(endOfLine);
            fileStream.write(`vesting_step_amount = ${account_data.vestingStepAmount}`);
            fileStream.write(endOfLine);
            fileStream.write(`vesting_total_amount = ${account_data.vestingTotalAmount}`);
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
            fileStream.write(`hash_algorithm = "${account_data.hashAlgorithm}"`);
            fileStream.write(endOfLine);
            fileStream.write(`hash_root = "${account_data.hashRoot}"`);
            fileStream.write(endOfLine);
            fileStream.write(`recipient = "${account_data.recipient}"`);
            fileStream.write(endOfLine);
            fileStream.write(`hash_count = ${account_data.hashCount}`);
            fileStream.write(endOfLine);
            if (account_data.timeout <= headBlockHeight) {
                htlcTimeoutBlock = await chainDS.getBlockAt(account_data.timeout);
                let htlcTimeoutTS = htlcTimeoutBlock.timestamp;
                fileStream.write(`timeout_ts = ${htlcTimeoutTS}`);
                fileStream.write(endOfLine);
            }
            fileStream.write(`timeout = ${account_data.timeout}`);
            fileStream.write(endOfLine);
            fileStream.write(`total_amount = ${account_data.totalAmount}`);
            fileStream.write(endOfLine);
            fileStream.write(endOfLine);
        }

    }
}

async function dump_head_block_data(chainData, fileStream, customGenesisDelay) {
    var endOfLine = require('os').EOL;
    let headBlockHeight = chainData.head.height;
    let headBlockTs = chainData.head.timestamp;
    fileStream.write("[nim_1_head_block]");
    fileStream.write(endOfLine);
    fileStream.write(`height = ${headBlockHeight}`);
    fileStream.write(endOfLine);
    fileStream.write(`timestamp = ${headBlockTs}`);
    fileStream.write(endOfLine);
    fileStream.write(`custom_genesis_delay = ${customGenesisDelay}`);
    fileStream.write(endOfLine);
    fileStream.write(endOfLine);
    return headBlockHeight;
}

async function dumpAccountsTree(fileName, chunkSize, customGenesisDelay) {
    var fs = require('fs')
    var fileStream = fs.createWriteStream(fileName);
    const db = await Nimiq.ConsensusDB.getFull(`main-`);
    const accounts = await Nimiq.Accounts.getPersistent(db);
    const chainDS = await Nimiq.ChainDataStore.getPersistent(db);

    // Try to get the Head hash to get the chain data
    const headHash = await chainDS.getHead();
    if (!headHash) {
        throw new Error(`Couldn't read from DB`);
    }

    const chainData = await chainDS.getChainData(headHash, true);

    // Dump the head block info
    const headBlockHeight = await dump_head_block_data(chainData, fileStream, customGenesisDelay);

    // Dump the Accounts tree in chunks
    let actualChunksize = chunkSize;
    let startAddress = '';

    while (chunkSize === actualChunksize) {
        accountsTreeChunk = await accounts.getAccountsChunk(startAddress, chunkSize);
        actualChunksize = accountsTreeChunk.length;
        console.log(`Processing chunk of size: ${actualChunksize}`);
        if (actualChunksize != 0) {
            startAddress = accountsTreeChunk[accountsTreeChunk.length - 1].prefix;
            await dumpAccountstoToml(accountsTreeChunk,  chainDS, headBlockHeight, fileStream);
        }
    }

    fileStream.end();
}

function help() {
    console.log(`Nimiq NodeJS tool to extract the accounts tree into a TOML file

Usage:
    node extract_tool.js <output-file-name> [options]

Description:
    output-file-name    TOML output file name

Options:
    --help                Display this help page
    --genesisdelay DELAY  Custom delay for the nimiq 2.0 genesis in minutes. The default is 60 minutes.
    --batchsize SIZE      Batch size. The default is 10000.
    `);
    rl.close();
}

(async () => {
    if (argv.help || argv._.length === 0) {
        return help();
    }
    argv.batchsize = argv.batchsize || 10000;
    argv.genesisdelay = argv.genesisdelay || 60;

    try {
        outputFileName = argv._[0];
        await dumpAccountsTree(outputFileName, argv.batchsize, argv.genesisdelay * 60);
        rl.close();
    } catch (e) {
        console.error(e.message || e.msg || e);
        rl.close();
    }
})();
