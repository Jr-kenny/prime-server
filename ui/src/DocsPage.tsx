import { useMemo, useState } from "react";
import { Icon } from "./icons";

type DocSection = { id: string; label: string; group: string };

const docSections: DocSection[] = [
  { id: "quickstart", label: "Quickstart", group: "Start here" },
  { id: "concepts", label: "Core concepts", group: "Start here" },
  { id: "http", label: "HTTP API", group: "Build" },
  { id: "sdk", label: "JavaScript SDK", group: "Build" },
  { id: "agents", label: "AI and agent integration", group: "Build" },
  { id: "privacy", label: "Private storage", group: "Build" },
  { id: "providers", label: "Providers and recovery", group: "Operate" },
  { id: "payments", label: "Payments and lifecycle", group: "Operate" },
  { id: "contract", label: "Contract reference", group: "Reference" },
  { id: "limits", label: "Limits and status", group: "Reference" }
];

const groups = ["Start here", "Build", "Operate", "Reference"];

const quickstartCode = `import { PrimeServerClient } from "@prime-server/sdk";

const prime = new PrimeServerClient({
  baseUrl: "https://api.primeserver.example/prime/v1",
  wallet: {
    address: walletAddress,
    signMessage: ({ message }) => walletClient.signMessage({ message })
  },
  walletClient,
  publicClient,
  registryAddress: "0xRegistryAddress"
});

const prepared = await prime.prepareBlob(bytes, {
  name: "reports/hello.txt",
  expirationSeconds: 86_400
});

await prime.registerBlob(prepared);
await prime.uploadRegisteredBlob(prepared, bytes, {
  contentType: "text/plain"
});`;

const authCode = `# 1. Ask for a short-lived wallet challenge
curl "https://api.primeserver.example/prime/v1/auth/challenge?address=0xYourWallet"

# 2. Sign the returned message, then create an API session
curl -X POST \\
  "https://api.primeserver.example/prime/v1/auth/session" \\
  -H "content-type: application/json" \\
  -d '{"address":"0xYourWallet","nonce":"...","signature":"0x..."}'`;

const uploadCode = `curl -X PUT \\
  "https://api.primeserver.example/prime/v1/blobs/0xYourWallet/reports/hello.txt" \\
  -H "Authorization: Bearer $PRIME_TOKEN" \\
  -H "Content-Type: text/plain" \\
  -H "x-prime-blob-id: 0xRegisteredBlobId" \\
  -H "x-prime-commitment: 0xRegisteredCommitment" \\
  -H "x-prime-chunk-size: 1048576" \\
  -H "x-prime-data-shards: 2" \\
  -H "x-prime-total-shards: 4" \\
  -H "x-prime-expires-at: 1780000000" \\
  --data-binary @hello.txt`;

const sdkCode = `const prepared = await prime.prepareBlob(bytes, {
  name: "reports/paid.txt",
  expirationSeconds: 86_400
});

await prime.registerPaidBlob(prepared, {
  storageMode: "public",
  accessPolicy: "owner_only"
});

await prime.uploadRegisteredBlob(prepared, bytes, {
  contentType: "text/plain"
});

const listing = await prime.list({ prefix: "reports/" });
const file = await prime.get("reports/paid.txt");`;

const privateCode = `const encrypted = await prime.prepareEncryptedBlob(bytes, {
  name: "private.bin",
  storageMode: "private",
  accessPolicy: "owner_only",
  fccPublicKey: teePublicKey,
  expirationSeconds: 86_400
});

await prime.registerPaidBlob(encrypted);
await prime.uploadRegisteredBlob(encrypted, encrypted.ciphertext);

// Providers and Prime RPC receive ciphertext only.
// Keep encrypted.fileKey in memory until an authorized release.`;

const computeCode = `const result = await prime.confidentialCompute({
  prepared: encrypted,
  senderAddress: "0xFccInstructionSender",
  verifierAddress: "0xFccResultVerifier",
  operation: "json_field_sum",
  field: "amount"
});

console.log(result.result.result); // { sum: ... }
// The FCC result is signed and submitted through the verifier.`;

const agentCode = `GET /health\nGET /prime/v1\nGET /prime/v1/auth/challenge?address=0x...\nPOST /prime/v1/auth/session\nwallet: createBlobNamed(...)\nPUT /prime/v1/blobs/{account}/{name}\nHEAD /prime/v1/blobs/{account}/{name}`;

function CodeBlock({ title, code }: { title: string; code: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return <div className="docs-code"><div className="docs-code-head"><span>{title}</span><button type="button" onClick={() => void copy()}><Icon name={copied ? "check" : "copy"}/>{copied ? "Copied" : "Copy"}</button></div><pre><code>{code}</code></pre></div>;
}

function SectionLabel({ children }: { children: string }) {
  return <div className="docs-section-label">{children}</div>;
}

export function DocsPage() {
  const [query, setQuery] = useState("");
  const [activeSection, setActiveSection] = useState("quickstart");
  const filteredSections = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return docSections;
    return docSections.filter((section) => `${section.label} ${section.group}`.toLowerCase().includes(normalized));
  }, [query]);

  function jumpTo(id: string) {
    setActiveSection(id);
    document.getElementById(`docs-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return <div className="docs-page">
    <section className="docs-hero">
      <div className="docs-hero-copy">
        <div className="docs-kicker"><span>PRIME SERVER DOCUMENTATION</span><b>v0.1</b></div>
        <h1>Build storage that can prove itself.</h1>
        <p>Register blobs with the user wallet, send matching bytes to Prime RPC, and build applications on a storage network whose placement and recovery state can be checked on Flare.</p>
        <div className="docs-hero-meta"><span><i><Icon name="check"/></i>Coston2 testnet</span><span><i><Icon name="cube"/></i>2-of-4 recovery</span><span><i><Icon name="server"/></i>HTTP and SDK</span></div>
      </div>
      <div className="docs-hero-card"><span className="docs-card-kicker">CURRENT SURFACE</span><strong>/prime/v1</strong><p>Registration-first blob storage for applications, wallets, and providers.</p><button type="button" onClick={() => jumpTo("http")}>Open API reference <Icon name="arrow"/></button></div>
    </section>

    <div className="docs-layout">
      <aside className="docs-sidebar">
        <div className="docs-sidebar-head"><span>Documentation</span><small>10 sections</small></div>
        <label className="docs-search"><Icon name="search"/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search docs" aria-label="Search documentation"/></label>
        <nav className="docs-nav" aria-label="Documentation sections">
          {groups.map((group) => {
            const items = filteredSections.filter((section) => section.group === group);
            if (!items.length) return null;
            return <div className="docs-nav-group" key={group}><span>{group}</span>{items.map((section) => <button type="button" key={section.id} className={activeSection === section.id ? "active" : ""} onClick={() => jumpTo(section.id)}><span>{section.label}</span><Icon name="arrow"/></button>)}</div>;
          })}
        </nav>
        {!filteredSections.length && <div className="docs-no-results">No sections match “{query}”.</div>}
        <div className="docs-sidebar-foot"><Icon name="shield"/><div><strong>Ownership stays onchain</strong><span>API sessions never create user-owned blobs.</span></div></div>
      </aside>

      <article className="docs-article">
        <section className="docs-section" id="docs-quickstart">
          <SectionLabel>01 / START HERE</SectionLabel>
          <h2>Register first, upload second</h2>
          <p className="docs-lead">Prime Server follows a registration-first flow. Your application computes the commitment locally, the wallet registers that exact record on Flare, and Prime RPC accepts bytes only after it verifies the onchain registration.</p>
          <div className="docs-step-grid"><div><b>01</b><strong>Prepare locally</strong><span>Clay encoding produces the blob commitment and 2-of-4 shard configuration.</span></div><div><b>02</b><strong>Register with wallet</strong><span>The connected wallet becomes the owner through <code>msg.sender</code>.</span></div><div><b>03</b><strong>Upload the match</strong><span>Prime RPC recomputes the commitment before distributing provider shards.</span></div><div><b>04</b><strong>Verify the result</strong><span>Read acknowledgements and finalization from the registry events.</span></div></div>
          <CodeBlock title="browser or Node client" code={quickstartCode}/>
          <div className="docs-callout"><Icon name="shield"/><div><strong>The API session is not ownership.</strong><p>Authentication limits API use and protects upload bandwidth. The Flare registration is the source of ownership, so a server session can never create a blob for another wallet.</p></div></div>
        </section>

        <section className="docs-section" id="docs-concepts">
          <SectionLabel>02 / MODEL</SectionLabel>
          <h2>Four ideas to keep in your head</h2>
          <p className="docs-lead">The same blob moves through a small number of verifiable boundaries. Build your app around these boundaries and the explorer, provider network, and recovery tooling stay consistent.</p>
          <div className="docs-concept-grid"><div><span className="docs-icon"><Icon name="wallet"/></span><strong>Wallet-owned records</strong><p>The user signs the registration transaction. Prime RPC verifies it before it accepts the body.</p></div><div><span className="docs-icon"><Icon name="cube"/></span><strong>Commitment before bytes</strong><p>Clients calculate the root locally. The RPC recomputes the encoding and rejects mismatches.</p></div><div><span className="docs-icon"><Icon name="server"/></span><strong>Independent providers</strong><p>Four providers hold separate shards. Their acknowledgements are bound to the blob and shard.</p></div><div><span className="docs-icon"><Icon name="recover"/></span><strong>Recovery is a lifecycle</strong><p>Two surviving data shards reconstruct the object, then the failed shard is rebuilt and reassigned.</p></div></div>
          <div className="docs-definition"><div><span>Pending</span><p>Registration exists on Flare, but storage has not finished.</p></div><div><span>Active</span><p>Provider acknowledgements are complete and the blob can be read.</p></div><div><span>Recovering</span><p>A failed placement is being rebuilt without changing the blob ID or root commitment.</p></div><div><span>Expired</span><p>The gateway hides the object. Provider deletion and name reuse remain lifecycle work.</p></div></div>
        </section>

        <section className="docs-section" id="docs-http">
          <SectionLabel>03 / BUILD</SectionLabel>
          <h2>HTTP API</h2>
          <p className="docs-lead">Use <code>/prime/v1</code> for external applications. The legacy <code>/v1</code> surface remains for internal proof harnesses.</p>
          <div className="docs-table-wrap"><table className="docs-table"><thead><tr><th>Method</th><th>Route</th><th>Use it for</th></tr></thead><tbody><tr><td><b>GET</b></td><td><code>/auth/challenge?address=0x...</code></td><td>Start a wallet session</td></tr><tr><td><b>POST</b></td><td><code>/auth/session</code></td><td>Exchange the signed challenge for a token</td></tr><tr><td><b>GET</b></td><td><code>/account</code></td><td>Read the authenticated account</td></tr><tr><td><b>PUT</b></td><td><code>/blobs/:account/:name</code></td><td>Upload bytes after registration confirms</td></tr><tr><td><b>GET</b></td><td><code>/blobs/:account/:name</code></td><td>Read a blob or a byte range</td></tr><tr><td><b>HEAD</b></td><td><code>/blobs/:account/:name</code></td><td>Read size, ETag, expiry, and blob headers</td></tr><tr><td><b>GET</b></td><td><code>/blobs/:account</code></td><td>List the owner-scoped namespace</td></tr></tbody></table></div>
          <div className="docs-two-column"><CodeBlock title="authenticate" code={authCode}/><CodeBlock title="upload after confirmation" code={uploadCode}/></div>
          <div className="docs-note"><strong>Range reads</strong><span>HTTP range responses are supported. The current implementation reconstructs the complete object before slicing the requested bytes, so efficient shard-range retrieval is a future optimization.</span></div>
        </section>

        <section className="docs-section" id="docs-sdk">
          <SectionLabel>04 / BUILD</SectionLabel>
          <h2>JavaScript SDK</h2>
          <p className="docs-lead">The repository includes <code>@prime-server/sdk</code>. It keeps registration, payment, authentication, encrypted preparation, and upload sequencing in one client.</p>
          <div className="docs-api-grid"><div><code>prepareBlob(input, options)</code><span>Encode bytes locally and return the blob ID, root commitment, size, expiry, and shard parameters.</span></div><div><code>registerBlob(prepared)</code><span>Send direct wallet registration and wait for a successful receipt.</span></div><div><code>registerPaidBlob(prepared, options)</code><span>Read the native quote and atomically pay plus register the blob.</span></div><div><code>uploadRegisteredBlob(prepared, body)</code><span>Authenticate, send cross-check headers, and wait for provider finalization.</span></div><div><code>list(options)</code><span>List an owner-scoped namespace with optional prefix and cursor.</span></div><div><code>get(name, options)</code><span>Retrieve bytes, including selected-wallet ciphertext and HTTP ranges.</span></div></div>
          <CodeBlock title="native paid storage" code={sdkCode}/>
        </section>

        <section className="docs-section" id="docs-agents">
          <SectionLabel>05 / BUILD</SectionLabel>
          <h2>Build for developers and agents</h2>
          <p className="docs-lead">The API is discoverable, registration-first, and explicit about its live boundaries. A developer or AI agent can inspect capabilities before it asks for a wallet signature or starts an upload.</p>
          <div className="docs-step-grid"><div><b>01</b><strong>Discover</strong><span>Check health and GET <code>/prime/v1</code> before choosing a feature.</span></div><div><b>02</b><strong>Prepare</strong><span>Compute the commitment locally and preserve the exact bytes and name.</span></div><div><b>03</b><strong>Approve</strong><span>Show the owner the chain write and payment before asking for a signature.</span></div><div><b>04</b><strong>Verify</strong><span>Read HEAD, content, provider acknowledgements, and registry events.</span></div></div>
          <CodeBlock title="safe agent sequence" code={agentCode}/>
          <div className="docs-callout"><Icon name="shield"/><div><strong>Agents must preserve the wallet boundary</strong><p>API authentication grants account-scoped use. It cannot create ownership, approve payment, or replace the registry transaction. OpenAPI and the full agent guide are available in the repository docs.</p></div></div>
        </section>

        <section className="docs-section" id="docs-privacy">
          <SectionLabel>06 / BUILD</SectionLabel>
          <h2>Private and confidential storage</h2>
          <p className="docs-lead">Privacy is a policy on the same storage network. Encrypt in the client before Clay encoding. Prime RPC and providers receive ciphertext, while Flare stores commitments to the policy, envelope, and metadata.</p>
          <div className="docs-mode-grid"><div><span className="docs-mode-pill public">PUBLIC</span><strong>Readable bytes</strong><p>Normal owner-scoped storage with visible blob metadata and standard retrieval.</p></div><div><span className="docs-mode-pill private">PRIVATE</span><strong>Owner-controlled decryption</strong><p>Encrypted bytes are stored. An authorized wallet can request a key package for its current device.</p></div><div><span className="docs-mode-pill confidential">CONFIDENTIAL</span><strong>Compute-only access</strong><p>Raw downloads are blocked. Approved operations run through the attested FCC boundary when deployed.</p></div></div>
          <CodeBlock title="encrypt before registration" code={privateCode}/>
          <CodeBlock title="run an approved confidential operation" code={computeCode}/>
          <div className="docs-callout warning"><Icon name="shield"/><div><strong>Live FCC configuration</strong><p>The application sends only the sealed envelope, operation, and ciphertext commitment. A live signed result still requires the official Coston2 proxy, indexer credentials, simulated-TEE registration, and configured sender and verifier contracts.</p></div></div>
        </section>

        <section className="docs-section" id="docs-providers">
          <SectionLabel>07 / OPERATE</SectionLabel>
          <h2>Providers and recovery</h2>
          <p className="docs-lead">Providers are independent storage operators. The coordinator assigns shards and verifies signed acknowledgements, while the registry records the placement and recovery lifecycle.</p>
          <div className="docs-flow"><div><b>1</b><strong>Assign</strong><span>Each blob gets four shard placements.</span></div><i/><div><b>2</b><strong>Acknowledge</strong><span>Providers return a commitment and size proof.</span></div><i/><div><b>3</b><strong>Detect failure</strong><span>Health or read failure starts recovery.</span></div><i/><div><b>4</b><strong>Rebuild</strong><span>Two surviving shards reconstruct the missing shard.</span></div></div>
          <div className="docs-two-column docs-plain-columns"><div><h3>Provider contract</h3><ul><li>Run an independent endpoint and data directory.</li><li>Store only the assigned shard bytes.</li><li>Expose health, full reads, and HTTP range reads.</li><li>Sign acknowledgements with blob, shard, commitment, and provider context.</li></ul></div><div><h3>Recovery proof</h3><ul><li>Record the failed provider and shard on Flare.</li><li>Assign a replacement provider.</li><li>Rebuild from any two surviving data shards.</li><li>Verify the rebuilt commitment before finalization.</li></ul></div></div>
        </section>

        <section className="docs-section" id="docs-payments">
          <SectionLabel>08 / OPERATE</SectionLabel>
          <h2>Payments and lifecycle</h2>
          <p className="docs-lead">Native Coston2 payment is part of the registration transaction. The registry quotes the total, provider pool, protocol fee, and per-shard reward before the wallet submits the paid record.</p>
          <div className="docs-payment-strip"><div><span>01</span><strong>Quote</strong><p>Size, shards, storage mode, and expiry produce a bound quote.</p></div><div><span>02</span><strong>Escrow</strong><p>The wallet pays and registers in one Flare transaction.</p></div><div><span>03</span><strong>Settle</strong><p>Finalization unlocks immediate rewards. The reserve waits until expiry.</p></div></div>
          <div className="docs-callout"><Icon name="check"/><div><strong>Payment claims stay scoped</strong><p>Immediate payment is claimed once per shard. After reassignment, the replacement provider receives the reserve at expiry without creating a second immediate reward.</p></div></div>
          <div className="docs-note"><strong>Interoperable assets</strong><span>XRP, FDC, and FAssets settlement require a real escrow or settlement path. They are separate integration work and are not described as atomic until the live mechanism is proven.</span></div>
        </section>

        <section className="docs-section" id="docs-contract">
          <SectionLabel>09 / REFERENCE</SectionLabel>
          <h2>Contract reference</h2>
          <p className="docs-lead">The Prime Server Registry is the authoritative record for ownership, commitments, placement, policy, payment state, and lifecycle events.</p>
          <div className="docs-table-wrap"><table className="docs-table"><thead><tr><th>Function or field</th><th>What it establishes</th><th>Caller</th></tr></thead><tbody><tr><td><code>createBlobNamed</code></td><td>Direct wallet-owned registration</td><td>User wallet</td></tr><tr><td><code>createBlobNamedPaid</code></td><td>Native payment plus registration</td><td>User wallet</td></tr><tr><td><code>blobs(blobId)</code></td><td>Owner, commitment, size, shards, status, expiry</td><td>Anyone</td></tr><tr><td><code>getBlobPolicy(blobId)</code></td><td>Storage mode, access policy, and privacy commitments</td><td>Anyone</td></tr><tr><td><code>placement(blobId, shard)</code></td><td>Current provider assignment</td><td>Anyone</td></tr><tr><td><code>acknowledgements(...)</code></td><td>Provider commitment, size, and acknowledgement state</td><td>Anyone</td></tr><tr><td><code>BlobFinalized</code></td><td>Storage reached active finalization</td><td>Registry event</td></tr></tbody></table></div>
        </section>

        <section className="docs-section" id="docs-limits">
          <SectionLabel>10 / REFERENCE</SectionLabel>
          <h2>Limits and current status</h2>
          <div className="docs-status-grid"><div><strong>2 MiB</strong><span>Current first chunkset capacity</span></div><div><strong>1 MiB</strong><span>Chunk size for the four-provider profile</span></div><div><strong>2 of 4</strong><span>Data shards required for reconstruction</span></div><div><strong>114</strong><span>Flare Coston2 chain ID</span></div></div>
          <div className="docs-status-list"><div><span className="status-dot live"/><div><strong>Available now</strong><p>Registration-first public blobs, native paid registration, wallet sessions, listing, full downloads, HTTP ranges, provider acknowledgements, live recovery proofs, and the no-sample explorer.</p></div></div><div><span className="status-dot staged"/><div><strong>Ready for FCC configuration</strong><p>Encrypted confidential preparation, compute-only policy registration, the approved operation set, live proxy polling, and signed result submission are implemented.</p></div></div><div><span className="status-dot planned"/><div><strong>Follow-up proof</strong><p>The official Coston2 indexer, simulated-TEE machine registration, and a live confidential compute evidence run still need to be completed before the result is called live.</p></div></div></div>
          <div className="docs-footer-note"><Icon name="file"/><span>These docs describe the Prime Server surface and its current proof boundary. The repository source remains the implementation reference.</span></div>
        </section>
      </article>
    </div>
  </div>;
}
