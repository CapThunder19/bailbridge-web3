import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const Milestone = {
  NONE: 0,
  THRESHOLD_FLAGGED: 1,
  SUPERINTENDENT_APPLICATION: 2,
  APPLICATION_FILED: 3,
  ORDER_ATTESTED: 4,
  ORDER_RECEIVED_BY_PRISON: 5,
  RELEASE_ACKNOWLEDGED: 6,
} as const;

const OrderStatus = { NONE: 0, ACTIVE: 1, REVOKED: 2, SUPERSEDED: 3 } as const;
const DocumentKind = { NONE: 0, APPLICATION_PDF: 1, ORDER_PDF: 2, ORDER_STRUCTURED: 3 } as const;

const ZERO = ethers.ZeroHash;
const rand = () => ethers.hexlify(ethers.randomBytes(32));
const h = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));

async function deployFixture() {
  const [admin, registrar, lawyer, issuer, prison, outsider] = await ethers.getSigners();
  const registry = await ethers.deployContract("BailRegistry", [admin.address]);
  await registry.waitForDeployment();

  await registry.grantRole(await registry.REGISTRAR_ROLE(), registrar.address);
  await registry.grantRole(await registry.LAWYER_ROLE(), lawyer.address);
  await registry.grantRole(await registry.ISSUER_ROLE(), issuer.address);
  await registry.grantRole(await registry.PRISON_ROLE(), prison.address);

  return { registry, admin, registrar, lawyer, issuer, prison, outsider };
}

/** A registered case with one filed application. */
async function caseWithApplicationFixture() {
  const f = await deployFixture();
  const caseId = rand();
  await f.registry.connect(f.registrar).registerCase(caseId, h("record-commitment"));
  const appPdfHash = h("application.pdf bytes");
  await f.registry.connect(f.lawyer).fileApplication(caseId, appPdfHash);
  return { ...f, caseId, appId: 1n, appPdfHash };
}

/** A registered case with an application and an ACTIVE attested order. */
async function caseWithOrderFixture() {
  const f = await caseWithApplicationFixture();
  const orderId = rand();
  const structuredHash = h("canonical order json");
  const orderPdfHash = h("order.pdf bytes");
  await f.registry.connect(f.issuer).attestOrder(f.caseId, f.appId, orderId, structuredHash, orderPdfHash);
  return { ...f, orderId, structuredHash, orderPdfHash };
}

describe("BailRegistry", () => {
  describe("role restrictions", () => {
    it("only REGISTRAR can register a case and anchor screening", async () => {
      const { registry, registrar, outsider, lawyer } = await loadFixture(deployFixture);
      const caseId = rand();
      await expect(registry.connect(outsider).registerCase(caseId, h("r")))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
        .withArgs(outsider.address, await registry.REGISTRAR_ROLE());
      await expect(registry.connect(registrar).registerCase(caseId, h("r")))
        .to.emit(registry, "CaseRegistered")
        .withArgs(caseId, h("r"), registrar.address);

      await expect(registry.connect(lawyer).anchorScreening(caseId, h("s"), 1)).to.be.revertedWithCustomError(
        registry,
        "AccessControlUnauthorizedAccount",
      );
      await expect(registry.connect(registrar).anchorScreening(caseId, h("s"), 1))
        .to.emit(registry, "ScreeningAnchored")
        .withArgs(caseId, h("s"), 1);
      const c = await registry.getCase(caseId);
      expect(c.screeningCommitment).to.equal(h("s"));
      expect(c.ruleVersion).to.equal(1);
      expect(await registry.caseCount()).to.equal(1n);
    });

    it("only LAWYER can file an application", async () => {
      const { registry, registrar, issuer, prison, lawyer } = await loadFixture(deployFixture);
      const caseId = rand();
      await registry.connect(registrar).registerCase(caseId, h("r"));
      for (const s of [registrar, issuer, prison]) {
        await expect(registry.connect(s).fileApplication(caseId, h("pdf"))).to.be.revertedWithCustomError(
          registry,
          "AccessControlUnauthorizedAccount",
        );
      }
      await expect(registry.connect(lawyer).fileApplication(caseId, h("pdf")))
        .to.emit(registry, "ApplicationFiled")
        .withArgs(caseId, 1n, h("pdf"), lawyer.address);
    });

    it("only ISSUER can attest, revoke or supersede orders", async () => {
      const { registry, caseId, appId, lawyer, prison, issuer } = await loadFixture(caseWithApplicationFixture);
      const orderId = rand();
      await expect(
        registry.connect(lawyer).attestOrder(caseId, appId, orderId, h("json"), h("pdf2")),
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
      await registry.connect(issuer).attestOrder(caseId, appId, orderId, h("json"), h("pdf2"));
      await expect(registry.connect(prison).revokeOrder(orderId, h("reason"))).to.be.revertedWithCustomError(
        registry,
        "AccessControlUnauthorizedAccount",
      );
      await expect(
        registry.connect(prison).supersedeOrder(orderId, rand(), h("json3"), h("pdf3"), h("reason")),
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });

    it("enforces a specific role per milestone", async () => {
      const { registry, caseId, orderId, registrar, prison, lawyer, issuer } = await loadFixture(caseWithOrderFixture);
      // THRESHOLD_FLAGGED is registrar-only
      await expect(
        registry.connect(prison).attestMilestone(caseId, ZERO, Milestone.THRESHOLD_FLAGGED, h("e")),
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
      await registry.connect(registrar).attestMilestone(caseId, ZERO, Milestone.THRESHOLD_FLAGGED, h("e"));

      // prison-only milestones
      for (const s of [registrar, lawyer, issuer]) {
        await expect(
          registry.connect(s).attestMilestone(caseId, ZERO, Milestone.SUPERINTENDENT_APPLICATION, h("e")),
        ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
        await expect(
          registry.connect(s).attestMilestone(caseId, orderId, Milestone.ORDER_RECEIVED_BY_PRISON, h("e")),
        ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
      }
      await registry.connect(prison).attestMilestone(caseId, ZERO, Milestone.SUPERINTENDENT_APPLICATION, h("e"));
    });

    it("rejects milestones that can only be recorded through dedicated functions", async () => {
      const { registry, caseId, lawyer, issuer } = await loadFixture(caseWithOrderFixture);
      await expect(registry.connect(lawyer).attestMilestone(caseId, ZERO, Milestone.APPLICATION_FILED, h("e")))
        .to.be.revertedWithCustomError(registry, "MilestoneNotAttestable")
        .withArgs(Milestone.APPLICATION_FILED);
      await expect(
        registry.connect(issuer).attestMilestone(caseId, ZERO, Milestone.ORDER_ATTESTED, h("e")),
      ).to.be.revertedWithCustomError(registry, "MilestoneNotAttestable");
      await expect(
        registry.connect(issuer).attestMilestone(caseId, ZERO, Milestone.NONE, h("e")),
      ).to.be.revertedWithCustomError(registry, "MilestoneNotAttestable");
    });

    it("lets the admin revoke a role", async () => {
      const { registry, admin, lawyer, caseId } = await loadFixture(caseWithApplicationFixture);
      await registry.connect(admin).revokeRole(await registry.LAWYER_ROLE(), lawyer.address);
      await expect(registry.connect(lawyer).fileApplication(caseId, h("another"))).to.be.revertedWithCustomError(
        registry,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  describe("duplicate prevention", () => {
    it("rejects a duplicate case ID and zero values", async () => {
      const { registry, registrar } = await loadFixture(deployFixture);
      const caseId = rand();
      await registry.connect(registrar).registerCase(caseId, h("r"));
      await expect(registry.connect(registrar).registerCase(caseId, h("r2")))
        .to.be.revertedWithCustomError(registry, "CaseAlreadyRegistered")
        .withArgs(caseId);
      await expect(registry.connect(registrar).registerCase(ZERO, h("r"))).to.be.revertedWithCustomError(
        registry,
        "ZeroValue",
      );
      await expect(registry.connect(registrar).registerCase(rand(), ZERO)).to.be.revertedWithCustomError(
        registry,
        "ZeroValue",
      );
    });

    it("rejects a document hash registered twice, across kinds", async () => {
      const { registry, caseId, appId, appPdfHash, lawyer, issuer } = await loadFixture(caseWithApplicationFixture);
      await expect(registry.connect(lawyer).fileApplication(caseId, appPdfHash))
        .to.be.revertedWithCustomError(registry, "DocumentAlreadyRegistered")
        .withArgs(appPdfHash);
      // an order cannot reuse the application PDF hash
      await expect(
        registry.connect(issuer).attestOrder(caseId, appId, rand(), h("json"), appPdfHash),
      ).to.be.revertedWithCustomError(registry, "DocumentAlreadyRegistered");
    });

    it("rejects duplicate milestones and duplicate order IDs", async () => {
      const { registry, caseId, orderId, registrar, prison, issuer, lawyer } = await loadFixture(caseWithOrderFixture);
      await registry.connect(registrar).attestMilestone(caseId, ZERO, Milestone.THRESHOLD_FLAGGED, h("e1"));
      await expect(registry.connect(registrar).attestMilestone(caseId, ZERO, Milestone.THRESHOLD_FLAGGED, h("e2")))
        .to.be.revertedWithCustomError(registry, "MilestoneAlreadyRecorded")
        .withArgs(caseId, Milestone.THRESHOLD_FLAGGED);

      await registry.connect(prison).attestMilestone(caseId, ZERO, Milestone.SUPERINTENDENT_APPLICATION, h("e3"));
      await expect(
        registry.connect(prison).attestMilestone(caseId, ZERO, Milestone.SUPERINTENDENT_APPLICATION, h("e4")),
      ).to.be.revertedWithCustomError(registry, "MilestoneAlreadyRecorded");

      await registry.connect(prison).attestMilestone(caseId, orderId, Milestone.ORDER_RECEIVED_BY_PRISON, h("e5"));
      await expect(
        registry.connect(prison).attestMilestone(caseId, orderId, Milestone.ORDER_RECEIVED_BY_PRISON, h("e6")),
      )
        .to.be.revertedWithCustomError(registry, "OrderAlreadyReceived")
        .withArgs(orderId);

      await registry.connect(prison).attestMilestone(caseId, orderId, Milestone.RELEASE_ACKNOWLEDGED, h("e7"));
      await expect(
        registry.connect(prison).attestMilestone(caseId, orderId, Milestone.RELEASE_ACKNOWLEDGED, h("e8")),
      ).to.be.revertedWithCustomError(registry, "MilestoneAlreadyRecorded");

      // reusing an order ID on a second application
      await registry.connect(lawyer).fileApplication(caseId, h("second application"));
      await expect(registry.connect(issuer).attestOrder(caseId, 2n, orderId, h("json-b"), h("pdf-b")))
        .to.be.revertedWithCustomError(registry, "OrderAlreadyExists")
        .withArgs(orderId);
    });

    it("rejects a second order for the same application", async () => {
      const { registry, caseId, appId, orderId, issuer } = await loadFixture(caseWithOrderFixture);
      await expect(registry.connect(issuer).attestOrder(caseId, appId, rand(), h("json-x"), h("pdf-x")))
        .to.be.revertedWithCustomError(registry, "ApplicationAlreadyHasOrder")
        .withArgs(appId, orderId);
    });
  });

  describe("case–application–order linkage", () => {
    it("requires a registered case for applications and milestones", async () => {
      const { registry, lawyer, prison } = await loadFixture(deployFixture);
      const unknown = rand();
      await expect(registry.connect(lawyer).fileApplication(unknown, h("pdf")))
        .to.be.revertedWithCustomError(registry, "CaseNotFound")
        .withArgs(unknown);
      await expect(
        registry.connect(prison).attestMilestone(unknown, ZERO, Milestone.SUPERINTENDENT_APPLICATION, h("e")),
      ).to.be.revertedWithCustomError(registry, "CaseNotFound");
    });

    it("rejects an order whose application belongs to a different case", async () => {
      const { registry, registrar, issuer, appId } = await loadFixture(caseWithApplicationFixture);
      const otherCase = rand();
      await registry.connect(registrar).registerCase(otherCase, h("other"));
      await expect(registry.connect(issuer).attestOrder(otherCase, appId, rand(), h("json"), h("pdf2")))
        .to.be.revertedWithCustomError(registry, "ApplicationCaseMismatch")
        .withArgs(appId, otherCase);
      await expect(registry.connect(issuer).attestOrder(otherCase, 99n, rand(), h("json"), h("pdf2")))
        .to.be.revertedWithCustomError(registry, "ApplicationNotFound")
        .withArgs(99n);
    });

    it("rejects prison milestones against an order of a different case", async () => {
      const { registry, registrar, prison, orderId } = await loadFixture(caseWithOrderFixture);
      const otherCase = rand();
      await registry.connect(registrar).registerCase(otherCase, h("other"));
      await expect(
        registry.connect(prison).attestMilestone(otherCase, orderId, Milestone.ORDER_RECEIVED_BY_PRISON, h("e")),
      )
        .to.be.revertedWithCustomError(registry, "OrderCaseMismatch")
        .withArgs(orderId, otherCase);
      await expect(
        registry.connect(prison).attestMilestone(otherCase, rand(), Milestone.ORDER_RECEIVED_BY_PRISON, h("e")),
      ).to.be.revertedWithCustomError(registry, "OrderNotFound");
    });

    it("rejects an order ID on case-level milestones", async () => {
      const { registry, caseId, orderId, prison } = await loadFixture(caseWithOrderFixture);
      await expect(
        registry.connect(prison).attestMilestone(caseId, orderId, Milestone.SUPERINTENDENT_APPLICATION, h("e")),
      )
        .to.be.revertedWithCustomError(registry, "UnexpectedOrderId")
        .withArgs(Milestone.SUPERINTENDENT_APPLICATION);
    });

    it("stores application and order records with correct links", async () => {
      const { registry, caseId, appId, orderId, structuredHash, orderPdfHash, appPdfHash, lawyer, issuer } =
        await loadFixture(caseWithOrderFixture);
      const app = await registry.getApplication(appId);
      expect(app.caseId).to.equal(caseId);
      expect(app.pdfHash).to.equal(appPdfHash);
      expect(app.lawyer).to.equal(lawyer.address);
      expect(app.orderId).to.equal(orderId);

      const order = await registry.getOrder(orderId);
      expect(order.caseId).to.equal(caseId);
      expect(order.appId).to.equal(appId);
      expect(order.structuredOrderHash).to.equal(structuredHash);
      expect(order.pdfHash).to.equal(orderPdfHash);
      expect(order.issuer).to.equal(issuer.address);
      expect(order.status).to.equal(OrderStatus.ACTIVE);
    });
  });

  describe("PDF hash vs structured order hash", () => {
    it("registers PDF and structured hashes separately with distinct kinds", async () => {
      const { registry, appId, orderId, structuredHash, orderPdfHash, appPdfHash } =
        await loadFixture(caseWithOrderFixture);
      const [pdfKind, pdfId] = await registry.verifyDocument(orderPdfHash);
      expect(pdfKind).to.equal(DocumentKind.ORDER_PDF);
      expect(pdfId).to.equal(orderId);

      const [jsonKind, jsonId] = await registry.verifyDocument(structuredHash);
      expect(jsonKind).to.equal(DocumentKind.ORDER_STRUCTURED);
      expect(jsonId).to.equal(orderId);

      const [appKind, appIdBytes] = await registry.verifyDocument(appPdfHash);
      expect(appKind).to.equal(DocumentKind.APPLICATION_PDF);
      expect(BigInt(appIdBytes)).to.equal(appId);

      const [noneKind] = await registry.verifyDocument(h("never registered"));
      expect(noneKind).to.equal(DocumentKind.NONE);
    });

    it("rejects an order whose structured hash equals its PDF hash", async () => {
      const { registry, caseId, appId, issuer } = await loadFixture(caseWithApplicationFixture);
      const same = h("same");
      await expect(
        registry.connect(issuer).attestOrder(caseId, appId, rand(), same, same),
      ).to.be.revertedWithCustomError(registry, "DuplicateHashes");
    });

    it("a one-byte change to the PDF bytes produces an unregistered hash", async () => {
      const { registry, caseId, appId, issuer } = await loadFixture(caseWithApplicationFixture);
      const original = ethers.toUtf8Bytes("%PDF-1.7 synthetic order body");
      const modified = Uint8Array.from(original);
      modified[modified.length - 1] ^= 0x01;
      const orderId = rand();
      await registry.connect(issuer).attestOrder(caseId, appId, orderId, h("json"), ethers.keccak256(original));
      const [okKind] = await registry.verifyDocument(ethers.keccak256(original));
      const [badKind] = await registry.verifyDocument(ethers.keccak256(modified));
      expect(okKind).to.equal(DocumentKind.ORDER_PDF);
      expect(badKind).to.equal(DocumentKind.NONE);
    });
  });

  describe("revocation", () => {
    it("revokes an ACTIVE order once, with a reason commitment", async () => {
      const { registry, caseId, orderId, issuer } = await loadFixture(caseWithOrderFixture);
      await expect(registry.connect(issuer).revokeOrder(orderId, ZERO)).to.be.revertedWithCustomError(
        registry,
        "ZeroValue",
      );
      await expect(registry.connect(issuer).revokeOrder(orderId, h("reason")))
        .to.emit(registry, "OrderRevoked")
        .withArgs(orderId, caseId, h("reason"), issuer.address);
      const order = await registry.getOrder(orderId);
      expect(order.status).to.equal(OrderStatus.REVOKED);
      expect(order.revocationReasonCommitment).to.equal(h("reason"));
      await expect(registry.connect(issuer).revokeOrder(orderId, h("again")))
        .to.be.revertedWithCustomError(registry, "OrderNotActive")
        .withArgs(orderId, OrderStatus.REVOKED);
    });

    it("blocks receipt and release acknowledgement against a revoked order", async () => {
      const { registry, caseId, orderId, issuer, prison } = await loadFixture(caseWithOrderFixture);
      await registry.connect(issuer).revokeOrder(orderId, h("reason"));
      await expect(
        registry.connect(prison).attestMilestone(caseId, orderId, Milestone.ORDER_RECEIVED_BY_PRISON, h("e")),
      )
        .to.be.revertedWithCustomError(registry, "OrderNotActive")
        .withArgs(orderId, OrderStatus.REVOKED);
    });

    it("blocks release acknowledgement if the order is revoked after receipt", async () => {
      const { registry, caseId, orderId, issuer, prison } = await loadFixture(caseWithOrderFixture);
      await registry.connect(prison).attestMilestone(caseId, orderId, Milestone.ORDER_RECEIVED_BY_PRISON, h("e"));
      await registry.connect(issuer).revokeOrder(orderId, h("reason"));
      await expect(
        registry.connect(prison).attestMilestone(caseId, orderId, Milestone.RELEASE_ACKNOWLEDGED, h("e2")),
      ).to.be.revertedWithCustomError(registry, "OrderNotActive");
    });

    it("keeps history intact after revocation", async () => {
      const { registry, caseId, orderId, orderPdfHash, structuredHash, issuer, prison, registrar } =
        await loadFixture(caseWithOrderFixture);
      await registry.connect(registrar).attestMilestone(caseId, ZERO, Milestone.THRESHOLD_FLAGGED, h("flag"));
      await registry.connect(prison).attestMilestone(caseId, orderId, Milestone.ORDER_RECEIVED_BY_PRISON, h("rcv"));
      const before = await registry.getMilestones(caseId);
      await registry.connect(issuer).revokeOrder(orderId, h("reason"));
      const after = await registry.getMilestones(caseId);

      expect(after.length).to.equal(before.length);
      expect(after.map((m) => Number(m.milestone))).to.deep.equal([
        Milestone.APPLICATION_FILED,
        Milestone.ORDER_ATTESTED,
        Milestone.THRESHOLD_FLAGGED,
        Milestone.ORDER_RECEIVED_BY_PRISON,
      ]);
      // documents still resolve to the (now revoked) order
      const [kind, id] = await registry.verifyDocument(orderPdfHash);
      expect(kind).to.equal(DocumentKind.ORDER_PDF);
      expect(id).to.equal(orderId);
      const order = await registry.getOrder(orderId);
      expect(order.structuredOrderHash).to.equal(structuredHash);
      expect(order.pdfHash).to.equal(orderPdfHash);
    });
  });

  describe("release acknowledgement prerequisites", () => {
    it("requires the prison to have recorded receipt of the order", async () => {
      const { registry, caseId, orderId, prison } = await loadFixture(caseWithOrderFixture);
      await expect(
        registry.connect(prison).attestMilestone(caseId, orderId, Milestone.RELEASE_ACKNOWLEDGED, h("e")),
      )
        .to.be.revertedWithCustomError(registry, "OrderNotReceived")
        .withArgs(orderId);
    });

    it("requires an existing order", async () => {
      const { registry, caseId, prison } = await loadFixture(caseWithOrderFixture);
      await expect(
        registry.connect(prison).attestMilestone(caseId, ZERO, Milestone.RELEASE_ACKNOWLEDGED, h("e")),
      ).to.be.revertedWithCustomError(registry, "OrderNotFound");
    });

    it("records the full journey; superintendent application and filing in either order", async () => {
      const f = await loadFixture(deployFixture);
      const caseId = rand();
      await f.registry.connect(f.registrar).registerCase(caseId, h("r"));
      await f.registry.connect(f.registrar).anchorScreening(caseId, h("s"), 1);
      await f.registry.connect(f.registrar).attestMilestone(caseId, ZERO, Milestone.THRESHOLD_FLAGGED, h("flag"));
      // lawyer files BEFORE the superintendent application — allowed
      await f.registry.connect(f.lawyer).fileApplication(caseId, h("app"));
      await f.registry.connect(f.prison).attestMilestone(caseId, ZERO, Milestone.SUPERINTENDENT_APPLICATION, h("sup"));
      const orderId = rand();
      await f.registry.connect(f.issuer).attestOrder(caseId, 1n, orderId, h("json"), h("orderpdf"));
      await f.registry.connect(f.prison).attestMilestone(caseId, orderId, Milestone.ORDER_RECEIVED_BY_PRISON, h("rcv"));
      await expect(
        f.registry.connect(f.prison).attestMilestone(caseId, orderId, Milestone.RELEASE_ACKNOWLEDGED, h("rel")),
      )
        .to.emit(f.registry, "MilestoneAttested")
        .withArgs(caseId, Milestone.RELEASE_ACKNOWLEDGED, orderId, 1n, h("rel"), f.prison.address, 5n);

      const ms = await f.registry.getMilestones(caseId);
      expect(ms.map((m) => Number(m.milestone))).to.deep.equal([
        Milestone.THRESHOLD_FLAGGED,
        Milestone.APPLICATION_FILED,
        Milestone.SUPERINTENDENT_APPLICATION,
        Milestone.ORDER_ATTESTED,
        Milestone.ORDER_RECEIVED_BY_PRISON,
        Milestone.RELEASE_ACKNOWLEDGED,
      ]);
      expect(ms[2].actor).to.equal(f.prison.address);
      expect(ms[3].actor).to.equal(f.issuer.address);
    });
  });

  describe("supersede (append-only replacement)", () => {
    it("marks the old order SUPERSEDED, links old -> new, and requires fresh receipt", async () => {
      const { registry, caseId, appId, orderId, issuer, prison } = await loadFixture(caseWithOrderFixture);
      await registry.connect(prison).attestMilestone(caseId, orderId, Milestone.ORDER_RECEIVED_BY_PRISON, h("rcv"));
      const newOrderId = rand();
      await expect(
        registry.connect(issuer).supersedeOrder(orderId, newOrderId, h("json-v2"), h("pdf-v2"), h("correction")),
      )
        .to.emit(registry, "OrderSuperseded")
        .withArgs(orderId, newOrderId, caseId, h("correction"));

      const oldOrder = await registry.getOrder(orderId);
      const newOrder = await registry.getOrder(newOrderId);
      expect(oldOrder.status).to.equal(OrderStatus.SUPERSEDED);
      expect(oldOrder.supersededBy).to.equal(newOrderId);
      expect(newOrder.status).to.equal(OrderStatus.ACTIVE);
      expect(newOrder.supersedes).to.equal(orderId);
      expect(newOrder.appId).to.equal(appId);
      expect((await registry.getApplication(appId)).orderId).to.equal(newOrderId);

      // receipt of the old order does not carry over
      await expect(
        registry.connect(prison).attestMilestone(caseId, newOrderId, Milestone.RELEASE_ACKNOWLEDGED, h("rel")),
      ).to.be.revertedWithCustomError(registry, "OrderNotReceived");
      await expect(
        registry.connect(prison).attestMilestone(caseId, orderId, Milestone.RELEASE_ACKNOWLEDGED, h("rel")),
      ).to.be.revertedWithCustomError(registry, "OrderNotActive");
      // cannot supersede a non-active order
      await expect(
        registry.connect(issuer).supersedeOrder(orderId, rand(), h("json-v3"), h("pdf-v3"), h("x")),
      ).to.be.revertedWithCustomError(registry, "OrderNotActive");
    });
  });
});
