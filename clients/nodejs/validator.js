class ValidatorRegistry {
    /**
     * @param {Address} validator_address
     * @param {string} signing_key
     * @param {string} voting_key
    */
    constructor(validator_address, signing_key, voting_key) {

        /** @type {Address} */
        this._validator_address = validator_address;
        /** @type {string} */
        this._signing_key = signing_key;
        /** @type {string} */
        this._voting_key = voting_key;

    }


    /**
     * Obtains the serialized data for validator registration
     * 
     * (All sizes in bytes)
     *  
     * <- 1  -><- 11 -> <-    32    -><-      20        ->
     * | Type | Unused | Signing key | Validator Address |
     * 
     * 
     * <- 1  -><- 6   -> <-           57                ->
     * | Type | Unused |        Voting key[0]            |
     * 
     * 
     * <- 1  -><- 6   -> <-           57                ->
     * | Type | Unused |        Voting key[1]            |
     * 
     * 
     * <- 1  -><- 6   -> <-           57                ->
     * | Type | Unused |        Voting key[2]            |
     * 
     * 
     * <- 1  -><- 6   -> <-           57                ->
     * | Type | Unused |        Voting key[3]            |
     * 
     * 
     * <- 1  -><- 6   -> <-           57                ->
     * | Type | Unused |        Voting key[4]            |
     * 
     */
    get_serialized_data() {

        let txns_data = [];

        // Serialize first part of the transaction data
        let data = new Nimiq.SerialBuffer(64);
        // First byte: type
        let type = 1;
        data.writeUint8(type);

        let unused = new Uint8Array(11);
        data.write(unused);

        //let pk = Nimiq.PublicKey.unserialize(Nimiq.BufferUtils.fromHex(this._signing_key));

        this._signing_key.serialize(data);

        // We are asumming validator address is already an Address
        this._validator_address.serialize(data);

        txns_data.push(data);

        // Extract the voting key
        let voting_key = Nimiq.BufferUtils.fromHex(this._voting_key)

        if (voting_key.length != 285) {
            console.error('Invalid voting key');
            process.exit(1);
        }

        // Create the next transactions
        let vk_unused = new Uint8Array(6);

        for (let i = 0; i < 5; i++) {

            data = new Nimiq.SerialBuffer(64);
            type += 1;
            data.writeUint8(type);
            data.write(vk_unused);
            // We read the voting key in 57 bytes chunks
            data.write(voting_key.read(57));
            txns_data.push(data);
        };

        return txns_data;
    }
}

function help() {
    console.log(`Nimiq NodeJS tool to register a new validator

Usage:
    node validator.js [options]

Description:
    If no arguments are provided, then all the validator parameters are generated and stored in a JSONC file
    Otherwise, the user must specify the path to the JSONC file with the validator configuration

Options:
    --help             Display this help page
    --validator        Path to the validator registry specification file (JSONC)
    `);
}

const START = Date.now();
const argv = require('minimist')(process.argv.slice(2));
const Nimiq = require('../../dist/node.js');
const config = require('./modules/Config.js')(argv);
const fs = require('fs');
const JSON5 = require('json5');
const { consoleTestResultHandler } = require('tslint/lib/test');

config.protocol = 'dumb'
config.type = 'nano';
config.network = "test";

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

const TAG = 'Node';
const $ = {};

(async () => {

    if (argv.help) {
        return help();
    }

    if (!argv.validator){
        // We are in validator configuration generation mode
        // We generate the validator paramaters and exit the tool
        console.log(" Generating new validator paramaters... ");

       process.exit(0);
    }

    console.log(" Reading validator configuration.. ");
    let validator_config = JSON5.parse(fs.readFileSync(argv.validator));
    
    console.log(validator_config);

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
    clientConfigBuilder.feature(Nimiq.Client.Feature.MEMPOOL);

    const clientConfig = clientConfigBuilder.build();
    const networkConfig = clientConfig.networkConfig;

    $.consensus = await (!config.volatile
        ? Nimiq.Consensus.nano(networkConfig)
        : Nimiq.Consensus.volatileNano(networkConfig));

    $.client = new Nimiq.Client(clientConfig, $.consensus);
    $.blockchain = $.consensus.blockchain;
    $.accounts = $.blockchain.accounts;
    $.mempool = $.consensus.mempool;
    $.network = $.consensus.network;

    Nimiq.Log.i(TAG, `Peer address: ${networkConfig.peerAddress.toString()} - public key: ${networkConfig.keyPair.publicKey.toHex()}`);

    const chainHeight = await $.client.getHeadHeight();
    const chainHeadHash = await $.client.getHeadHash();
    Nimiq.Log.i(TAG, `Blockchain state: height=${chainHeight}, headHash=${chainHeadHash}`);

    // This is the hardcoded address dedicated to validator registration
    const recipientAddr = Nimiq.Address.fromUserFriendlyAddress("NQ07 0000 0000 0000 0000 0000 0000 0000 0000");

    // Extract the validator configuration
    let validatorPrivateKey = Nimiq.PrivateKey.unserialize(Nimiq.BufferUtils.fromHex(validator_config.ValidatorAccount.PrivateKey));
    let signingPrivateKey = Nimiq.PrivateKey.unserialize(Nimiq.BufferUtils.fromHex(validator_config.SigningKey.PrivateKey));
    // This is currently a string in Hex format
    const VotingKey = validator_config.VotingKey.PublicKey;

    // Create the KeyPairs
    const validatorKeyPair = Nimiq.KeyPair.derive(validatorPrivateKey);
    const SigningKeyPair = Nimiq.KeyPair.derive(signingPrivateKey);

    // Create a new validator registry
    let validator = new ValidatorRegistry(validatorKeyPair.publicKey.toAddress(), SigningKeyPair.publicKey, VotingKey);

    // Get the transaction's data
    let data = validator.get_serialized_data();

    $.client.addTransactionListener(async (tx) => {
        console.log(" TXN Listener");
        console.log(tx);
    }, [recipientAddr]);


    let consensusState = Nimiq.Client.ConsensusState.CONNECTING;
    $.client.addConsensusChangedListener(async (state) => {
        consensusState = state;
        if (state === Nimiq.Client.ConsensusState.ESTABLISHED) {
            Nimiq.Log.i(TAG, `Blockchain ${config.type}-consensus established in ${(Date.now() - START) / 1000}s.`);
            const chainHeight = await $.client.getHeadHeight();
            const chainHeadHash = await $.client.getHeadHash();
            Nimiq.Log.i(TAG, `Current state: height=${chainHeight}, headHash=${chainHeadHash}`);
          
            // Send the txns for validator registration
            for (let i = 0; i < 6; i++) {

                console.log("sending transaction: ");

                let transaction = new Nimiq.ExtendedTransaction(validatorKeyPair.publicKey.toAddress(), Nimiq.Account.Type.BASIC, recipientAddr, Nimiq.Account.Type.BASIC, 10, 10, chainHeight, Nimiq.Transaction.Flag.NONE, data[i]);
                let proof = new Nimiq.SerialBuffer(Nimiq.SignatureProof.SINGLE_SIG_SIZE);
                Nimiq.SignatureProof.singleSig(validatorKeyPair.publicKey, Nimiq.Signature.create(validatorKeyPair.privateKey, validatorKeyPair.publicKey, transaction.serializeContent())).serialize(proof);
                transaction.proof = proof;

                let result = await $.client.sendTransaction(transaction);

                console.log(" Transaction result: ");
                console.log(result);

                console.log(" Transaction hash: ");
                console.log(transaction.hash().toHex());
            }

            //let mp_txns = $.mempool.getTransactions();
            //console.log("Mempool transactions: ");
            //console.log(mp_txns);
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

    $.client.addHeadChangedListener(async (hash, reason) => {
        const head = await $.client.getBlock(hash, false);
        Nimiq.Log.i(TAG, `Now at block: ${head.height} (${reason})`);
    });


    $.network.on('peer-joined', (peer) => {
        Nimiq.Log.i(TAG, `Connected to ${peer.peerAddress.toString()}`);
    });
    $.network.on('peer-left', (peer) => {
        Nimiq.Log.i(TAG, `Disconnected from ${peer.peerAddress.toString()}`);
    });


})().catch(e => {
    console.error(e);
    process.exit(1);
});
