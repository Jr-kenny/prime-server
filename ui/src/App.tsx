import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPublicClient, createWalletClient, custom, http, type Address, type EIP1193Provider } from "viem";
import { Icon } from "./icons";
import { DocsPage } from "./DocsPage";
import { blobFinalizedEvent, coston2, registryAbi } from "./registry";
import { formatBytes, prepareFile, shortHex, type PreparedBlob } from "./prime";
import {
  blobExpiry,
  blobStatusClass,
  eventTransaction,
  emptyExplorerData,
  loadExplorerData,
  previewData,
  statsDetail,
  type ExplorerBlob,
  type ExplorerData,
  type ExplorerEvent,
  type ExplorerProvider,
  type Placement
} from "./explorer";

declare global { interface Window { ethereum?: EIP1193Provider } }

const apiUrl = (import.meta.env.VITE_PRIME_RPC_URL || "http://localhost:8787/prime/v1").replace(/\/$/, "");
const registryAddress = import.meta.env.VITE_REGISTRY_ADDRESS as Address | undefined;
const previewMode = import.meta.env.VITE_DEMO_MODE !== "false";
const liveMode = !previewMode && Boolean(registryAddress);
const explorer = coston2.blockExplorers.default.url;

type View = "overview" | "blobs" | "events" | "providers" | "recovery" | "docs";
type UploadState = "idle" | "preparing" | "prepared" | "registering" | "registered" | "uploading" | "active" | "error";

const navItems: Array<{ id: View; label: string; icon: string }> = [
  { id: "overview", label: "Overview", icon: "grid" },
  { id: "blobs", label: "Blobs", icon: "cube" },
  { id: "events", label: "Events", icon: "pulse" },
  { id: "providers", label: "Providers", icon: "server" },
  { id: "recovery", label: "Recovery", icon: "recover" }
];

function connectLabel(account?: Address) { return account ? shortHex(account, 8, 4) : "Connect wallet"; }

export function App() {
  const [account, setAccount] = useState<Address>();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [selectedBlob, setSelectedBlob] = useState<ExplorerBlob>();
  const [view, setView] = useState<View>("overview");
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState<string>();
  const [data, setData] = useState<ExplorerData>(liveMode ? emptyExplorerData : previewData);
  const [loading, setLoading] = useState(liveMode);
  const [dataError, setDataError] = useState<string>();
  const publicClient = useMemo(() => createPublicClient({ chain: coston2, transport: http(coston2.rpcUrls.default.http[0]) }), []);

  const refresh = useCallback(async () => {
    if (!liveMode || !registryAddress) return;
    setLoading(true);
    setDataError(undefined);
    try {
      setData(await loadExplorerData(publicClient, registryAddress));
    } catch (error) {
      setDataError(error instanceof Error ? error.message : "Coston2 registry feed could not be loaded");
    } finally {
      setLoading(false);
    }
  }, [publicClient]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function connect() {
    if (!window.ethereum) return setNotice("Install a browser wallet to connect to Coston2.");
    try {
      const wallet = createWalletClient({ chain: coston2, transport: custom(window.ethereum) });
      const [address] = await wallet.requestAddresses();
      setAccount(address);
      setNotice(`Connected to ${shortHex(address, 8, 4)}.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Wallet connection failed"); }
  }

  const normalizedSearch = search.trim().toLowerCase();
  const visibleBlobs = data.blobs.filter((blob) => `${blob.name} ${blob.id} ${blob.owner} ${blob.status}`.toLowerCase().includes(normalizedSearch));
  const visibleEvents = data.events.filter((event) => `${event.type} ${event.transaction} ${event.owner} ${event.name} ${event.detail || ""}`.toLowerCase().includes(normalizedSearch));

  function openView(nextView: View) {
    setView(nextView);
    setSelectedBlob(undefined);
  }

  const sourceLabel = liveMode ? (dataError ? "Live feed unavailable" : "Live registry feed") : "Interface preview";
  const sourceMessage = liveMode && dataError
    ? "The Coston2 registry feed could not be loaded. No sample rows are substituted in live mode."
    : data.source === "coston2"
    ? `Reading Prime Server Registry events from Coston2${data.latestBlock ? ` through block ${data.latestBlock}` : ""}.`
    : "Displayed totals, events, health, and blob rows are sample data. Set VITE_DEMO_MODE=false with a registry address for live Coston2 data.";

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><span/><span/><span/></div><div><strong>Prime</strong><small>SERVER</small></div></div>
      <nav aria-label="Prime Server sections">
        {navItems.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => openView(item.id)}><Icon name={item.icon}/>{item.label}{item.id === "blobs" && <span>{String(data.stats.blobs).padStart(2, "0")}</span>}{item.id === "providers" && <i/>}</button>)}
      </nav>
      <div className="side-bottom">
        <div className="network-card"><div className="network-head"><span className="live-dot"/>{liveMode ? "Coston2 testnet" : "Coston2 preview"}</div><p>{sourceLabel}</p><strong>{registryAddress ? shortHex(registryAddress, 9, 5) : "Not configured"}</strong><div className="network-line"><span>Prime RPC</span><b className={import.meta.env.VITE_PRIME_RPC_URL ? "good" : "preview"}>{import.meta.env.VITE_PRIME_RPC_URL ? "Configured" : "Local default"}</b></div></div>
        <button className={`docs-link ${view === "docs" ? "active" : ""}`} onClick={() => openView("docs")}><Icon name="file"/><span>Developer docs<small>Build on Prime Server</small></span><Icon name="arrow"/></button>
      </div>
    </aside>

    <main>
      <header className="topbar">
        <button className="mobile-brand" onClick={() => openView("overview")}>P</button>
        <div className="global-search"><Icon name="search"/><input aria-label="Search blobs, owners or transactions" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search blobs, owners or transactions"/><kbd>⌘ K</kbd></div>
        <div className="top-actions"><div className="chain-pill"><span className="flare-icon">F</span>Coston2</div><button className="wallet-button" onClick={connect}><Icon name="wallet"/>{connectLabel(account)}</button></div>
      </header>

      <div className="page">
        {view !== "docs" && <div className={`preview-banner ${data.source === "coston2" ? "live" : ""}`}><span>{sourceLabel.toUpperCase()}</span> {sourceMessage}{liveMode && <button className="banner-action" onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>}</div>}
        {view !== "docs" && dataError && <div className="data-error"><Icon name="pulse"/><span>{dataError}</span><button onClick={() => void refresh()}>Retry</button></div>}

        {view === "overview" && <Overview data={data} visibleBlobs={visibleBlobs} visibleEvents={visibleEvents} loading={loading} onOpenBlob={setSelectedBlob} onView={openView} onStore={() => setUploadOpen(true)}/>}
        {view === "blobs" && <CollectionView title="Blobs" eyebrow="REGISTRY OBJECTS" description="Every named blob registered on Flare, its lifecycle state, and its recovery placement." actionLabel="Store a blob" onAction={() => setUploadOpen(true)}><BlobTable blobs={visibleBlobs} onOpenBlob={setSelectedBlob} live={data.source === "coston2"}/></CollectionView>}
        {view === "events" && <CollectionView title="Events" eyebrow="CHAIN ACTIVITY" description="Registration, placement, acknowledgement, payment, recovery, and finalization activity." actionLabel="Refresh" onAction={() => void refresh()}><EventTable events={visibleEvents} live={data.source === "coston2"}/></CollectionView>}
        {view === "providers" && <CollectionView title="Providers" eyebrow="PLACEMENT NETWORK" description="The operators Prime Server can assign shards to, as recorded by the registry." actionLabel="Store a blob" onAction={() => setUploadOpen(true)}><ProviderTable providers={data.providers} live={data.source === "coston2"}/></CollectionView>}
        {view === "recovery" && <RecoveryView data={data} onOpenBlob={setSelectedBlob}/>}
        {view === "docs" && <DocsPage />}
      </div>
    </main>

    {uploadOpen && <UploadPanel account={account} onConnect={connect} onClose={() => setUploadOpen(false)} onCompleted={() => { void refresh(); }}/>}
    {selectedBlob && <BlobDetail blob={selectedBlob} live={data.source === "coston2"} onClose={() => setSelectedBlob(undefined)}/>}
    {notice && <div className="toast" onClick={() => setNotice(undefined)}>{notice}<Icon name="close"/></div>}
  </div>;
}

function Overview({ data, visibleBlobs, visibleEvents, loading, onOpenBlob, onView, onStore }: { data: ExplorerData; visibleBlobs: ExplorerBlob[]; visibleEvents: ExplorerEvent[]; loading: boolean; onOpenBlob: (blob: ExplorerBlob) => void; onView: (view: View) => void; onStore: () => void }) {
  const stats = data.stats;
  return <>
    <section className="hero-row"><div><div className="eyebrow">VERIFIABLE STORAGE ON FLARE</div><h1>Your files, built to survive.</h1><p>Store once. Recover from any two of four providers. Verify every step on Coston2.</p></div><button className="primary" onClick={onStore}><Icon name="upload"/>Store a blob</button></section>
    <section className="metrics">
      <Metric label="BLOBS STORED" value={String(stats.blobs).padStart(2, "0")} detail={`${stats.activeBlobs} active`} icon="cube" tone="green" />
      <Metric label="STORAGE USED" value={formatBytes(stats.storageUsed)} detail="Across indexed blobs" icon="server" tone="blue" />
      <Metric label="BLOB EVENTS" value={String(stats.events).padStart(2, "0")} detail="Lifecycle activity" icon="pulse" tone="purple" />
      <Metric label="RECOVERIES" value={String(stats.recoveries).padStart(2, "0")} detail="Recovery transitions" icon="recover" tone="amber" />
      <Metric label="PLACEMENT GROUPS" value={String(stats.placementGroups).padStart(2, "0")} detail="One group per blob" icon="grid" tone="purple" />
      <Metric label="STORAGE PROVIDERS" value={String(stats.providers).padStart(2, "0")} detail={statsDetail(stats)} icon="server" tone="green" />
    </section>
    <section className="panel explorer-panel"><div className="explorer-band"><div><h2>Prime Explorer</h2><p>{data.source === "coston2" && data.latestBlock ? `COSTON2 TESTNET · BLOCK ${data.latestBlock}` : "COSTON2 TESTNET"}</p></div><div className="explorer-search"><Icon name="search"/><span>SEARCH ON PRIME SERVER</span><kbd>⌘</kbd><kbd>K</kbd></div></div><div className="events-head"><div><h2>Blob events</h2><p>Registration, placement, acknowledgement, recovery, payment, and finalization</p></div><button className="text-button" onClick={() => onView("events")}>View all <Icon name="arrow"/></button></div><EventTable events={visibleEvents.slice(0, 5)} live={data.source === "coston2"} loading={loading}/></section>
    <section className="content-grid"><div className="panel blob-panel"><div className="panel-head"><div><h2>Recent blobs</h2><p>Files registered and stored across the network</p></div><button className="text-button" onClick={() => onView("blobs")}>View all <Icon name="arrow"/></button></div><BlobTable blobs={visibleBlobs.slice(0, 4)} onOpenBlob={onOpenBlob} live={data.source === "coston2"} loading={loading}/></div><NetworkPanel data={data}/></section>
    <section className="proof-strip"><div><span className="flare-icon">F</span><p><small>SETTLED ON</small><strong>Flare Coston2</strong></p></div><div className="proof-flow"><span><i className="done"><Icon name="check"/></i>Commit locally</span><b/><span><i className="done"><Icon name="check"/></i>Register onchain</span><b/><span><i className="done"><Icon name="check"/></i>Distribute shards</span><b/><span><i className="done"><Icon name="check"/></i>Provider attestations</span></div><a href={explorer} target="_blank" rel="noreferrer">Open explorer <Icon name="external"/></a></section>
  </>;
}

function CollectionView({ title, eyebrow, description, actionLabel, onAction, children }: { title: string; eyebrow: string; description: string; actionLabel: string; onAction: () => void; children: ReactNode }) {
  return <><section className="view-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div><button className="primary" onClick={onAction}>{actionLabel === "Store a blob" && <Icon name="upload"/>}{actionLabel === "Refresh" && <Icon name="refresh"/>}{actionLabel}</button></section>{children}</>;
}

function Metric({ label, value, suffix, detail, icon, tone }: { label: string; value: string; suffix?: string; detail: string; icon: string; tone: string }) {
  return <div className="metric"><div className={`metric-icon ${tone}`}><Icon name={icon}/></div><div><small>{label}</small><strong>{value} {suffix && <em>{suffix}</em>}</strong><p><i className={tone}/>{detail}</p></div></div>;
}

function BlobTable({ blobs, onOpenBlob, live, loading = false }: { blobs: ExplorerBlob[]; onOpenBlob: (blob: ExplorerBlob) => void; live: boolean; loading?: boolean }) {
  if (loading) return <div className="empty-state"><Icon name="pulse"/><strong>Reading registry state…</strong><p>Fetching named blobs, policies, placements, and acknowledgements from Coston2.</p></div>;
  if (!blobs.length) return <div className="empty-state"><Icon name="cube"/><strong>No blobs indexed yet</strong><p>{live ? "The selected registry range has no named blobs." : "Preview rows will appear here while the live feed is disabled."}</p></div>;
  return <div className="table-wrap"><table><thead><tr><th>BLOB</th><th>OWNER</th><th>SIZE</th><th>EXPIRES</th><th>RECOVERY</th><th>STATUS</th><th/></tr></thead><tbody>{blobs.map((blob, index) => <tr key={blob.id} onClick={() => onOpenBlob(blob)}><td><div className="blob-name"><span className={`file-icon f${index % 4}`}><Icon name="file"/></span><span><button className="table-link" onClick={(event) => { event.stopPropagation(); onOpenBlob(blob); }}>{blob.name}</button><small>{shortHex(blob.id, 12, 7)}</small></span></div></td><td className="mono">{shortHex(blob.owner, 8, 5)}</td><td>{formatBytes(blob.size)}</td><td>{blobExpiry(blob.expiresAt)}</td><td><span className="recovery-pill">{Array.from({ length: blob.totalShards }, (_, shard) => <i key={shard} className={shard < blob.acknowledgementCount ? "" : "faded"}/>)}{blob.dataShards} of {blob.totalShards}</span></td><td><span className={`status ${blobStatusClass(blob.status)}`}><i/>{blob.status}</span></td><td><Icon className="row-arrow" name="arrow"/></td></tr>)}</tbody></table></div>;
}

function EventTable({ events, live, loading = false }: { events: ExplorerEvent[]; live: boolean; loading?: boolean }) {
  if (loading) return <div className="empty-state compact"><Icon name="pulse"/><span>Loading chain activity…</span></div>;
  if (!events.length) return <div className="empty-state compact"><Icon name="pulse"/><span>{live ? "No events in the selected block range." : "No preview events match your search."}</span></div>;
  return <div className="table-wrap"><table className="events-table"><thead><tr><th>TYPE</th><th>TRANSACTION</th><th>OWNER</th><th>BLOB NAME</th><th>DETAIL</th><th>TIME</th><th/></tr></thead><tbody>{events.map((event) => <tr key={event.id}><td><span className={`event-type ${event.type.toLowerCase()}`}>{event.type}</span></td><td className="mono">{event.transaction.startsWith("0x") && live ? <a className="table-link mono" href={`${explorer}/tx/${event.transaction}`} target="_blank" rel="noreferrer">{eventTransaction(event)}</a> : eventTransaction(event)}</td><td className="mono">{event.owner ? shortHex(event.owner, 8, 5) : "—"}</td><td><strong>{event.name}</strong></td><td>{event.detail || "—"}</td><td>{event.time}</td><td><Icon className="row-arrow" name="arrow"/></td></tr>)}</tbody></table></div>;
}

function ProviderTable({ providers, live }: { providers: ExplorerProvider[]; live: boolean }) {
  if (!providers.length) return <div className="empty-state"><Icon name="server"/><strong>No providers indexed yet</strong><p>{live ? "Provider registration events are outside the selected block range." : "Preview providers will appear here while the live feed is disabled."}</p></div>;
  return <div className="table-wrap"><table><thead><tr><th>PROVIDER</th><th>OPERATOR</th><th>ENDPOINT</th><th>REGISTERED</th><th>STATUS</th></tr></thead><tbody>{providers.map((provider) => <tr key={provider.id}><td><div className="provider-cell"><span className="provider-dot"><Icon name="server"/></span><strong>Provider {provider.id}</strong></div></td><td className="mono">{shortHex(provider.operator, 9, 6)}</td><td className="mono endpoint-cell">{provider.endpoint || "Endpoint hidden"}</td><td>{provider.registeredBlock ? `Block ${provider.registeredBlock}` : "—"}</td><td><span className={`status ${provider.active ? "active" : "pending"}`}><i/>{provider.active ? "Online" : "Inactive"}</span></td></tr>)}</tbody></table></div>;
}

function NetworkPanel({ data }: { data: ExplorerData }) {
  const providers = data.providers.slice(0, 4);
  return <div className="panel network-panel"><div className="panel-head"><div><h2>Network recovery</h2><p>{data.source === "coston2" ? "Current registry provider topology" : "Four-provider preview topology"}</p></div><span className="healthy"><i/>{data.stats.activeProviders === data.stats.providers && data.stats.providers > 0 ? "Healthy" : "Degraded"}</span></div><div className="topology"><div className="origin-node"><div className="node-core"><div className="brand-mark small"><span/><span/><span/></div></div><strong>2 of 4</strong><small>needed to recover</small></div><svg className="connections" viewBox="0 0 400 190" preserveAspectRatio="none"><path d="M200 95 C140 95 150 36 78 36"/><path d="M200 95 C140 95 150 154 78 154"/><path d="M200 95 C260 95 250 36 322 36"/><path d="M200 95 C260 95 250 154 322 154"/></svg>{[0, 1, 2, 3].map((index) => { const provider = providers[index]; return <div className={`provider-node p${index + 1}`} key={provider?.id || index}><span><Icon name="server"/><i className={provider?.active === false ? "offline" : ""}/></span><strong>{provider ? `Provider ${provider.id}` : "Awaiting provider"}</strong><small>{provider ? `${provider.active ? "Online" : "Offline"} · registry` : "Not indexed"}</small></div>; })}</div><div className="recovery-note"><Icon name="shield"/><div><strong>Fault-tolerant by design</strong><p>Any two healthy shards can rebuild the original file. Provider acknowledgements are recorded on Flare.</p></div></div></div>;
}

function RecoveryView({ data, onOpenBlob }: { data: ExplorerData; onOpenBlob: (blob: ExplorerBlob) => void }) {
  const recoveryEvents = data.events.filter((event) => event.type === "Recovery" || event.type === "Rebuilt");
  return <><section className="view-header"><div><div className="eyebrow">FAULT TOLERANCE</div><h1>Recovery</h1><p>Track failed shards, replacements, and rebuilt commitments across the network.</p></div><span className="view-badge"><Icon name="shield"/>2-of-4 recovery</span></section><section className="content-grid recovery-grid"><NetworkPanel data={data}/><div className="panel recovery-summary"><div className="panel-head"><div><h2>Recovery state</h2><p>Derived from registry lifecycle events</p></div><span className="healthy"><i/>{data.stats.recoveries} transitions</span></div><div className="recovery-stat"><strong>{data.stats.recoveries}</strong><span>recovery transitions indexed</span></div><div className="recovery-stat"><strong>{data.stats.activeProviders} / {data.stats.providers}</strong><span>providers responding</span></div><div className="recovery-copy">When a provider fails, the coordinator reassigns the shard and records the rebuilt commitment. The original blob ID and commitment remain stable.</div></div></section><section className="panel"><div className="panel-head"><div><h2>Recovery activity</h2><p>Start and rebuild events from Coston2</p></div></div><EventTable events={recoveryEvents} live={data.source === "coston2"}/></section>{recoveryEvents.length > 0 && <div className="recovery-blob-links">{data.blobs.filter((blob) => recoveryEvents.some((event) => event.blobId === blob.id)).map((blob) => <button key={blob.id} className="recovery-link" onClick={() => onOpenBlob(blob)}><Icon name="cube"/>{blob.name}<Icon name="arrow"/></button>)}</div>}</>;
}

function BlobDetail({ blob, live, onClose }: { blob: ExplorerBlob; live: boolean; onClose: () => void }) {
  return <div className="detail-backdrop" onClick={onClose}><aside className="detail-drawer" onClick={(event) => event.stopPropagation()}><div className="detail-head"><div><span className="eyebrow">BLOB RECORD</span><h2>{blob.name}</h2><p>{blob.storageMode} storage · {blob.accessPolicy}</p></div><button className="icon-button" onClick={onClose}><Icon name="close"/></button></div><div className="detail-status-row"><span className={`status ${blobStatusClass(blob.status)}`}><i/>{blob.status}</span><span>{blob.acknowledgementCount} / {blob.totalShards} acknowledgements</span></div><div className="detail-grid"><Detail label="Blob ID" value={blob.id}/><Detail label="Owner" value={blob.owner}/><Detail label="Size" value={formatBytes(blob.size)}/><Detail label="Expires" value={blobExpiry(blob.expiresAt)}/><Detail label="Clay commitment" value={blob.commitment}/><Detail label="Payment" value={blob.paymentStatus}/><Detail label="Policy" value={blob.policyCommitment || "No policy recorded"}/><Detail label="Origin" value={blob.origin}/></div><div className="detail-section"><div className="detail-section-head"><div><h3>Placement group</h3><p>{blob.dataShards} data shards · {blob.totalShards} total shards</p></div><span className="mono">{live ? `Block ${blob.createdBlock || "—"}` : "Preview"}</span></div><div className="detail-placements">{blob.placements.map((placement) => <div key={placement.shard} className={placement.acknowledged ? "acknowledged" : "waiting"}><span><Icon name={placement.acknowledged ? "check" : "server"}/></span><div><strong>Shard {String(placement.shard).padStart(2, "0")}</strong><small>{placement.provider}</small></div><em>{placement.acknowledged ? "Acknowledged" : "Waiting"}</em></div>)}</div></div>{blob.transaction && live && <a className="detail-explorer-link" href={`${explorer}/tx/${blob.transaction}`} target="_blank" rel="noreferrer">Open registration transaction <Icon name="external"/></a>}</aside></div>;
}

function UploadPanel({ account, onConnect, onClose, onCompleted }: { account?: Address; onConnect: () => void; onClose: () => void; onCompleted: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File>();
  const [name, setName] = useState("");
  const [days, setDays] = useState(30);
  const [prepared, setPrepared] = useState<PreparedBlob>();
  const [state, setState] = useState<UploadState>("idle");
  const [error, setError] = useState<string>();
  const [registrationTx, setRegistrationTx] = useState<`0x${string}`>();
  const [finalizationTx, setFinalizationTx] = useState<`0x${string}`>();
  const [acks, setAcks] = useState(0);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [token, setToken] = useState<string>();
  const publicClient = useMemo(() => createPublicClient({ chain: coston2, transport: http(coston2.rpcUrls.default.http[0]) }), []);

  async function choose(selected?: File) {
    if (!selected) return;
    setFile(selected); setName(selected.name); setPrepared(undefined); setState("idle"); setError(undefined); setRegistrationTx(undefined); setFinalizationTx(undefined); setAcks(0); setPlacements([]);
  }

  async function prepare() {
    if (!file) return;
    try { setError(undefined); setState("preparing"); setPrepared(await prepareFile(file, name, Math.floor(Date.now() / 1000) + days * 86400)); setState("prepared"); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); setState("error"); }
  }

  async function authenticate(address: Address, wallet: ReturnType<typeof createWalletClient>) {
    if (token) return token;
    const challengeResponse = await fetch(`${apiUrl}/auth/challenge?address=${address}`);
    if (!challengeResponse.ok) throw new Error("Prime RPC authentication is unavailable");
    const challenge = await challengeResponse.json();
    const signature = await wallet.signMessage({ account: address, message: challenge.message });
    const response = await fetch(`${apiUrl}/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, nonce: challenge.nonce, signature }) });
    if (!response.ok) throw new Error((await response.json()).error || "Prime RPC authentication failed");
    const session = await response.json(); setToken(session.token); return session.token as string;
  }

  async function readProgress(blob: PreparedBlob) {
    if (!registryAddress) return 0;
    const raw = await publicClient.readContract({ address: registryAddress, abi: registryAbi, functionName: "blobs", args: [blob.blobId] }) as readonly unknown[];
    const count = Number(raw[6]); setAcks(count);
    const next: Placement[] = [];
    for (let shard = 0; shard < blob.totalShards; shard++) {
      const providerId = await publicClient.readContract({ address: registryAddress, abi: registryAbi, functionName: "placement", args: [blob.blobId, shard] }) as bigint;
      let endpoint = "";
      if (providerId > 0n) { const provider = await publicClient.readContract({ address: registryAddress, abi: registryAbi, functionName: "providers", args: [providerId] }) as readonly unknown[]; endpoint = String(provider[1] || ""); }
      const acknowledgement = providerId > 0n ? await publicClient.readContract({ address: registryAddress, abi: registryAbi, functionName: "acknowledgements", args: [blob.blobId, providerId, shard] }) as readonly unknown[] : undefined;
      next.push({ shard, providerId: Number(providerId), provider: providerId > 0n ? `Provider ${providerId}` : "Awaiting assignment", endpoint, acknowledged: Boolean(acknowledgement?.[3]) });
    }
    setPlacements(next);
    return Number(raw[7]);
  }

  async function registerAndUpload() {
    if (!prepared || !file || !account) return;
    if (!window.ethereum || !registryAddress) { setError("Set VITE_REGISTRY_ADDRESS and connect an injected wallet before using the live flow."); setState("error"); return; }
    let interval: number | undefined;
    try {
      setError(undefined); setState("registering");
      const wallet = createWalletClient({ account, chain: coston2, transport: custom(window.ethereum) });
      const hash = await wallet.writeContract({ address: registryAddress, abi: registryAbi, functionName: "createBlobNamed", args: [prepared.blobId, prepared.name, prepared.commitment, BigInt(prepared.size), prepared.chunkSize, prepared.dataShards, prepared.totalShards, BigInt(prepared.expiresAt)] });
      setRegistrationTx(hash);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Blob registration reverted on Coston2");
      setState("registered");
      const sessionToken = await authenticate(account, wallet);
      setState("uploading");
      interval = window.setInterval(() => readProgress(prepared).catch(() => undefined), 1800);
      const response = await fetch(`${apiUrl}/blobs/${encodeURIComponent(account)}/${prepared.name.split("/").map(encodeURIComponent).join("/")}`, { method: "PUT", headers: { authorization: `Bearer ${sessionToken}`, "content-type": file.type || "application/octet-stream", "x-prime-blob-id": prepared.blobId, "x-prime-commitment": prepared.commitment, "x-prime-chunk-size": String(prepared.chunkSize), "x-prime-data-shards": String(prepared.dataShards), "x-prime-total-shards": String(prepared.totalShards), "x-prime-expires-at": String(prepared.expiresAt) }, body: file });
      if (!response.ok) throw new Error((await response.json()).error || "Prime RPC upload failed");
      const finalStatus = await readProgress(prepared);
      setState(finalStatus === 1 || finalStatus === 3 ? "active" : "uploading");
      const logs = await publicClient.getLogs({ address: registryAddress, event: blobFinalizedEvent, args: { blobId: prepared.blobId }, fromBlock: receipt.blockNumber });
      if (logs.at(-1)?.transactionHash) setFinalizationTx(logs.at(-1)!.transactionHash);
      onCompleted();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); setState("error"); }
    finally { if (interval !== undefined) window.clearInterval(interval); }
  }

  const stage = state === "active" ? 4 : state === "uploading" ? 3 : state === "registered" ? 2 : state === "registering" ? 1 : prepared ? 0 : -1;
  return <div className="modal-backdrop"><section className="upload-panel"><div className="upload-head"><div><span className="eyebrow">NEW STORAGE RECORD</span><h2>Store a blob</h2><p>Every proof stays visible from your device to Flare.</p></div><button className="icon-button" onClick={onClose}><Icon name="close"/></button></div><div className="stepper">{["Prepare", "Register", "Upload", "Acknowledge", "Active"].map((label, index) => <div className={index <= stage ? "reached" : ""} key={label}><span>{index < stage ? <Icon name="check"/> : index + 1}</span><small>{label}</small></div>)}</div>{!prepared && <div className="upload-form"><button className="drop-zone" onClick={() => inputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void choose(event.dataTransfer.files[0]); }}><Icon name="upload"/><strong>{file ? file.name : "Choose a file or drop it here"}</strong><span>{file ? `${formatBytes(file.size)} · ${file.type || "Unknown type"}` : "Up to 2 MiB on the current network"}</span></button><input hidden ref={inputRef} type="file" onChange={(event) => void choose(event.target.files?.[0])}/><label>Blob name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="reports/example.pdf"/></label><label>Storage duration<select value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option></select></label><div className="recovery-config"><span><Icon name="shield"/></span><div><strong>Clay 2-of-4 recovery</strong><p>Four provider shards. Any two can reconstruct the original bytes.</p></div><b>Fixed</b></div><button className="primary wide" disabled={!file || state === "preparing"} onClick={() => void prepare()}>{state === "preparing" ? "Computing Clay commitment…" : "Prepare registration"}<Icon name="arrow"/></button></div>}{prepared && <div className="prepared-view"><div className="file-summary"><span className="file-icon f0"><Icon name="file"/></span><div><strong>{prepared.name}</strong><small>{formatBytes(prepared.size)} · expires {new Date(prepared.expiresAt * 1000).toLocaleDateString()}</small></div><button onClick={() => { setPrepared(undefined); setState("idle"); }}>Change</button></div><div className="proof-details"><Detail label="Blob ID" value={prepared.blobId}/><Detail label="Clay commitment" value={prepared.commitment}/><Detail label="Recovery" value="2 data shards · 4 total shards"/><Detail label="Chunk size" value="1 MiB"/></div><div className="live-timeline"><Timeline title="Local preparation" text="Clay commitment computed on this device" status="done"/><Timeline title="Coston2 registration" text={registrationTx ? shortHex(registrationTx, 14, 8) : "Wallet signature required"} status={state === "registering" ? "working" : registrationTx ? "done" : "waiting"} link={registrationTx ? `${explorer}/tx/${registrationTx}` : undefined}/><Timeline title="Provider placement" text={placements.length ? `${placements.filter((placement) => placement.provider !== "Awaiting assignment").length} of 4 shards assigned` : "Starts after registration confirms"} status={state === "uploading" ? "working" : stage > 2 ? "done" : "waiting"}/><div className="provider-progress">{[0, 1, 2, 3].map((index) => <div key={index} className={placements[index]?.acknowledged ? "acked" : placements[index]?.provider !== "Awaiting assignment" ? "assigned" : ""}><span><Icon name={placements[index]?.acknowledged ? "check" : "server"}/></span><p><strong>{placements[index]?.provider || `Provider ${index + 1}`}</strong><small>{placements[index]?.acknowledged ? "Acknowledged" : placements[index]?.provider !== "Awaiting assignment" && placements[index] ? "Assigned" : "Waiting"}</small></p></div>)}</div><Timeline title="Finalization" text={finalizationTx ? shortHex(finalizationTx, 14, 8) : state === "active" ? "Blob is active on Coston2" : "Requires all four acknowledgements"} status={state === "active" ? "done" : "waiting"} link={finalizationTx ? `${explorer}/tx/${finalizationTx}` : undefined}/></div>{error && <div className="error-box">{error}</div>}{state === "active" ? <div className="success-box"><Icon name="check"/><div><strong>Blob active</strong><p>Registration, placement, acknowledgements, and finalization are complete.</p></div></div> : account ? <button className="primary wide" disabled={["registering", "registered", "uploading"].includes(state)} onClick={() => void registerAndUpload()}>{state === "registering" ? "Confirming registration…" : state === "uploading" || state === "registered" ? `Storing shards · ${acks}/4 acknowledged` : "Register and store on Coston2"}<Icon name="arrow"/></button> : <button className="primary wide" onClick={onConnect}><Icon name="wallet"/>Connect wallet to continue</button>}</div>}</section></div>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><small>{label}</small><p className={value.startsWith("0x") ? "mono" : ""}>{value.startsWith("0x") ? shortHex(value, 18, 10) : value}</p>{value.startsWith("0x") && <button onClick={() => navigator.clipboard.writeText(value)}><Icon name="copy"/></button>}</div>;
}

function Timeline({ title, text, status, link }: { title: string; text: string; status: "done" | "working" | "waiting"; link?: string }) {
  return <div className={`timeline-row ${status}`}><span>{status === "done" ? <Icon name="check"/> : status === "working" ? <i/> : ""}</span><div><strong>{title}</strong><p>{text}</p></div>{link && <a href={link} target="_blank" rel="noreferrer"><Icon name="external"/></a>}</div>;
}
