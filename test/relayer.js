/* global accounts */
const ethers = require("ethers");
const { formatBytes32String } = require("ethers").utils;
const { parseRelayReceipt } = require("../utils/utilities.js");

const Proxy = require("../build/Proxy");
const BaseWallet = require("../build/BaseWallet");
const BadModuleRelayer = require("../build/BadModuleRelayer");
const RelayerModule = require("../build/RelayerModule");
const TestModule = require("../build/TestModule");
const Registry = require("../build/ModuleRegistry");
const GuardianManager = require("../build/GuardianManager");
const GuardianStorage = require("../build/GuardianStorage");
const LimitStorage = require("../build/LimitStorage");
const ApprovedTransfer = require("../build/ApprovedTransfer");
const RecoveryManager = require("../build/RecoveryManager"); // non-owner only module
const NftTransfer = require("../build/NftTransfer"); // owner only module
const CryptoKittyTest = require("../build/CryptoKittyTest");

const TestManager = require("../utils/test-manager");
const { getRandomAddress } = require("../utils/utilities.js");

const MODULE_NOT_AUTHORISED_FOR_WALLET = "RM: module not authorised";
const INVALID_DATA_REVERT_MSG = "RM: Invalid data";
const DUPLICATE_REQUEST_REVERT_MSG = "RM: Duplicate request";

describe("RelayManager", function () {
  this.timeout(10000);

  const manager = new TestManager();
  const { deployer } = manager;
  let { getNonceForRelay } = manager;
  getNonceForRelay = getNonceForRelay.bind(manager);
  const owner = accounts[1].signer;

  let registry;
  let guardianStorage;
  let limitStorage;
  let guardianManager;
  let recoveryManager;
  let wallet;
  let approvedTransfer;
  let nftTransferModule;
  let testModule;
  let testModuleNew;
  let relayerModule;

  before(async () => {
    registry = await deployer.deploy(Registry);
    guardianStorage = await deployer.deploy(GuardianStorage);
    limitStorage = await deployer.deploy(LimitStorage);
    relayerModule = await deployer.deploy(RelayerModule, {}, registry.contractAddress, guardianStorage.contractAddress, limitStorage.contractAddress );
    manager.setRelayerModule(relayerModule);
  })

  beforeEach(async () => {
    // ApprovedTransfer is a sample non-OnlyOwner module
    approvedTransfer = await deployer.deploy(ApprovedTransfer, {}, registry.contractAddress, guardianStorage.contractAddress);
    const cryptoKittyTest = await deployer.deploy(CryptoKittyTest);
    // NFTTransferModule is a sample OnlyOwner module
    nftTransferModule = await deployer.deploy(NftTransfer, {},
      registry.contractAddress,
      guardianStorage.contractAddress,
      cryptoKittyTest.contractAddress);
    guardianManager = await deployer.deploy(GuardianManager, {}, registry.contractAddress, guardianStorage.contractAddress, 24, 12);
    recoveryManager = await deployer.deploy(RecoveryManager, {}, registry.contractAddress, guardianStorage.contractAddress, 36, 120);

    testModule = await deployer.deploy(TestModule, {}, registry.contractAddress, guardianStorage.contractAddress, false, 0);
    testModuleNew = await deployer.deploy(TestModule, {}, registry.contractAddress, guardianStorage.contractAddress, false, 0);

    const walletImplementation = await deployer.deploy(BaseWallet);
    const proxy = await deployer.deploy(Proxy, {}, walletImplementation.contractAddress);
    wallet = deployer.wrapDeployedContract(BaseWallet, proxy.contractAddress);

    await wallet.init(owner.address,
      [relayerModule.contractAddress,
        approvedTransfer.contractAddress,
        nftTransferModule.contractAddress,
        guardianManager.contractAddress,
        recoveryManager.contractAddress,
        testModule.contractAddress]);
  });

  describe("relaying module transactions", () => {

    it("should fail when _data is less than 36 bytes", async () => {
      const params = []; // the first argument is not the wallet address, which should make the relaying rever
      await assert.revertWith(
        manager.relay(testModule, "clearInt", params, wallet, [owner]), INVALID_DATA_REVERT_MSG,
      );
    });

    it("should fail when module is not authorised", async () => {
      const params = [wallet.contractAddress, 2];
      await assert.revertWith(
        manager.relay(testModuleNew, "setIntOwnerOnly", params, wallet, [owner]), MODULE_NOT_AUTHORISED_FOR_WALLET,
      );
    });


    it("should fail when the first param is not a wallet ", async () => {
      const params = [owner.address, 4]; // the first argument is not the wallet address, which should make the relaying revert
      await assert.revertWith(
        manager.relay(testModule, "setIntOwnerOnly", params, wallet, [owner]), MODULE_NOT_AUTHORISED_FOR_WALLET,
      );
    });

    it("should fail a duplicate transaction", async () => {
      const params = [wallet.contractAddress, 2];
      const nonce = await getNonceForRelay();
      const relayParams = [testModule, "setIntOwnerOnly", params, wallet, [owner],
        accounts[9].signer, false, 2000000, nonce];
      await manager.relay(...relayParams);
      await assert.revertWith(
        manager.relay(...relayParams), DUPLICATE_REQUEST_REVERT_MSG,
      );
    });

    it("should update the nonce after transaction", async () => {
      const nonce = await getNonceForRelay();
      await manager.relay(testModule, "setIntOwnerOnly", [wallet.contractAddress, 2], wallet, [owner],
        accounts[9].signer, false, 2000000, nonce);

      const updatedNonce = await relayerModule.getNonce(wallet.contractAddress);
      const updatedNonceHex = await ethers.utils.hexZeroPad(updatedNonce.toHexString(), 32);
      assert.equal(nonce, updatedNonceHex);
    });

    it("should only allow ApprovedTransfer and RecoveryManager module functions to be called by the RelayerModule", async () => {
      const randomAddress = await getRandomAddress();

      await assert.revertWith(
        approvedTransfer.transferToken(wallet.contractAddress, randomAddress, randomAddress, 1, ethers.constants.HashZero),
        "BM: must be a module",
      );

      await assert.revertWith(
        approvedTransfer.callContract(wallet.contractAddress, randomAddress, 1, ethers.constants.HashZero),
        "BM: must be a module",
      );

      await assert.revertWith(
        approvedTransfer.approveTokenAndCallContract(
          wallet.contractAddress,
          randomAddress,
          randomAddress,
          1,
          randomAddress,
          ethers.constants.HashZero,
        ),
        "BM: must be a module",
      );

      await assert.revertWith(recoveryManager.executeRecovery(wallet.contractAddress, randomAddress), "BM: must be a module");
      await assert.revertWith(recoveryManager.cancelRecovery(wallet.contractAddress), "BM: must be a module");
      await assert.revertWith(recoveryManager.transferOwnership(wallet.contractAddress, randomAddress), "BM: must be a module");
    });

    it("should fail to refund", async () => {
      const nonce = await getNonceForRelay();

      const newowner = accounts[5].signer;
      const guardian = accounts[6].signer;
      await guardianManager.from(owner).addGuardian(wallet.contractAddress, guardian.address);

      const txReceipt = await manager.relay(
        recoveryManager,
        "transferOwnership",
        [wallet.contractAddress, newowner.address],
        wallet,
        [owner, guardian],
        accounts[9].signer,
        false,
        2000000,
        nonce,
        1,
      );

      const { error } = parseRelayReceipt(txReceipt);
      assert.equal(error, "RM: refund failed");
    });

    it("should fail if required signatures is 0 and OwnerRequirement is not Anyone", async () => {
      const badRelayerModule = await deployer.deploy(BadModuleRelayer, {}, registry.contractAddress, guardianStorage.contractAddress);
      await assert.revertWith(
        manager.relay(badRelayerModule, "setIntOwnerOnly", [wallet.contractAddress, 2], wallet, [owner]), "RM: Wrong number of required signatures",
      );
    });
  });

  // describe("addModule transactions", () => {
  //   it("should succeed when relayed on OnlyOwnerModule modules", async () => {
  //     await registry.registerModule(testModuleNew.contractAddress, formatBytes32String("testModuleNew"));
  //     const params = [wallet.contractAddress, testModuleNew.contractAddress];
  //     await manager.relay(nftTransferModule, "addModule", params, wallet, [owner]);

  //     const isModuleAuthorised = await wallet.authorised(testModuleNew.contractAddress);
  //     assert.isTrue(isModuleAuthorised);
  //   });

  //   it("should succeed when called directly on OnlyOwnerModule modules", async () => {
  //     await registry.registerModule(testModuleNew.contractAddress, formatBytes32String("testModuleNew"));
  //     await nftTransferModule.from(owner).addModule(wallet.contractAddress, testModuleNew.contractAddress);

  //     const isModuleAuthorised = await wallet.authorised(testModuleNew.contractAddress);
  //     assert.isTrue(isModuleAuthorised);
  //   });

  //   it("should fail when relayed on non-OnlyOwnerModule modules", async () => {
  //     await registry.registerModule(testModuleNew.contractAddress, formatBytes32String("testModuleNew"));
  //     const params = [wallet.contractAddress, testModuleNew.contractAddress];
  //     const txReceipt = await manager.relay(approvedTransfer, "addModule", params, wallet, [owner]);
  //     const { success, error } = parseRelayReceipt(txReceipt);
  //     assert.isFalse(success);
  //     assert.equal(error, "BM: msg.sender must be an owner for the wallet");

  //     const isModuleAuthorised = await wallet.authorised(testModuleNew.contractAddress);
  //     assert.isFalse(isModuleAuthorised);
  //   });

  //   it("should succeed when called directly on non-OnlyOwnerModule modules", async () => {
  //     await registry.registerModule(testModuleNew.contractAddress, formatBytes32String("testModuleNew"));
  //     await approvedTransfer.from(owner).addModule(wallet.contractAddress, testModuleNew.contractAddress);
  //     const isModuleAuthorised = await wallet.authorised(testModuleNew.contractAddress);
  //     assert.isTrue(isModuleAuthorised);
  //   });

  //   it("should fail to add module which is not registered", async () => {
  //     await assert.revertWith(approvedTransfer.from(owner).addModule(wallet.contractAddress, testModuleNew.contractAddress),
  //       "BM: module is not registered");
  //   });
  // });
});
