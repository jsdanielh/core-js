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
async function dumpAccountstoToml(accountsTreeChunk, fileStream) {
    accountsTreeChunk.forEach(function(accountTreeNode, index, array) {
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
            fileStream.write(`timeout = ${account_data.timeout}`);
            fileStream.write(endOfLine);
            fileStream.write(`total_amount = ${account_data.totalAmount}`);
            fileStream.write(endOfLine);
            fileStream.write(endOfLine);
        }

    })
}

async function dumpAccountsTree(fileName, chunkSize) {
    var fs = require('fs')
    var FileStream = fs.createWriteStream(fileName);
    const db = await Nimiq.ConsensusDB.getFull(`main-`);
    const accounts = await Nimiq.Accounts.getPersistent(db);

    let actualChunksize = chunkSize;
    let startAddress = '';

    while (chunkSize === actualChunksize) {
        accountsTreeChunk = await accounts.getAccountsChunk(startAddress, chunkSize);
        actualChunksize = accountsTreeChunk.length;
        console.log(`Processing chunk of size: ${actualChunksize}`);
        if (actualChunksize != 0) {
            startAddress = accountsTreeChunk[accountsTreeChunk.length - 1].prefix;
            await dumpAccountstoToml(accountsTreeChunk, FileStream);
        }
    }

    FileStream.end()
}

function help() {
    console.log(`Nimiq NodeJS tool to extract the accounts tree into a TOML file

Usage:
    node extract_tool.js <output-file-name> [options]

Description:
    output-file-name    TOML output file name

Options:
    --help              Display this help page
    --batchsize SIZE    Batch size. The default is 10000.
    `);
    rl.close();
}

(async () => {
    if (argv.help || argv._.length === 0) {
        return help();
    }
    argv.batchsize = argv.batchsize || 10000;

    try {
        outputFileName = argv._[0];
        await dumpAccountsTree(outputFileName, argv.batchsize);
        rl.close();
    } catch (e) {
        console.error(e.message || e.msg || e);
        rl.close();
    }
})();
