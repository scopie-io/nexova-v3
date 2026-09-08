import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, classifyForHint, type Coverage, type Health, type Job, type JobEvent, type LinkHint, type StepState, type StoreMeta, type TemplateManifest } from "./api";

const STEP_LABELS: Record<string, string> = {
  detect: "Reading your links",
  ingest: "Collecting profile & products",
  discover: "Finding your other channels",
  attachments: "Reading screenshots & files",
  research: "Researching your brand on the web",
  normalize: "Building your catalog",
  assets: "Saving your images",
  enrich: "Designing copy, theme & layout",
  template: "Choosing a template",
  compose: "Assembling the website",
  build: "Compiling the site",
  deploy: "Publishing",
};

const PLATFORMS = ["TikTok Shop", "Instagram", "Shopee", "Facebook", "Lazada", "Shopify", "Any website"];
const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,.csv,.tsv,.json,.txt";

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [templates, setTemplates] = useState<TemplateManifest[]>([]);
  const [stores, setStores] = useState<StoreMeta[]>([]);
  const [job, setJob] = useState<Job | null>(null);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
    api.templates().then(setTemplates).catch(() => {});
    api.stores().then(setStores).catch(() => {});
  }, [job?.status]);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("job");
    if (id && !job) api.job(id).then(setJob).catch(() => {});
  }, []);

  const start = async (input: string, options: Parameters<typeof api.createJob>[1], files: File[]) => {
    const j = await api.createJob(input, options, files);
    window.history.replaceState(null, "", `?job=${j.id}`);
    setJob(j);
  };

  return (
    <div className="page">
      <Nav offline={health?.offline ?? null} />
      {job ? (
        <BuildView
          job={job}
          onNew={() => {
            window.history.replaceState(null, "", "/");
            setJob(null);
          }}
          onRebuild={async (slug, templateId) => setJob(await api.rebuild(slug, templateId))}
          templates={templates}
        />
      ) : (
        <>
          <Hero onStart={start} templates={templates} health={health} />
          <HowItWorks />
          {stores.length > 0 && <RecentStores stores={stores} onOpen={(s) => window.open(s.siteUrl ?? `/s/${s.slug}/`, "_blank")} onRebuild={async (s) => setJob(await api.rebuild(s.slug))} />}
        </>
      )}
      <footer className="footer">
        <span>© {new Date().getFullYear()} Nexova</span>
        <span>{health ? `${health.offline ? "Offline mode" : health.model} · ${health.templates.length} template${health.templates.length === 1 ? "" : "s"}` : "API unreachable"}</span>
      </footer>
    </div>
  );
}

function Nav({ offline }: { offline: boolean | null }) {
  return (
    <header className="nav">
      <a className="brand" href="/">
        <span className="brand-mark">N</span>
        nexova
      </a>
      <nav className="nav-links">
        <a href="#how">How it works</a>
        <a href="#recent">Your stores</a>
        <a href="/api/usage" target="_blank" rel="noreferrer">
          Usage
        </a>
      </nav>
      <div className="nav-right">
        {offline && <span className="pill pill-warn">Offline mode: add ANTHROPIC_API_KEY</span>}
        <a className="btn btn-dark" href="#top">
          Get started
        </a>
      </div>
    </header>
  );
}

interface Picked {
  file: File;
  url: string | null;
}

function Hero({ onStart, templates, health }: { onStart: (input: string, options: Parameters<typeof api.createJob>[1], files: File[]) => Promise<void>; templates: TemplateManifest[]; health: Health | null }) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [templateId, setTemplateId] = useState<string>("");
  const [instructions, setInstructions] = useState("");
  const [currency, setCurrency] = useState("");
  const [skipBuild, setSkipBuild] = useState(false);
  const [skipResearch, setSkipResearch] = useState(false);
  const [skipDiscovery, setSkipDiscovery] = useState(false);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const hints = useMemo<LinkHint[]>(() => {
    const seen = new Set<string>();
    return input
      .split(/\r?\n/)
      .map((l) => classifyForHint(l.trim()))
      .filter((h): h is LinkHint => !!h && !seen.has(h.url) && !!seen.add(h.url));
  }, [input]);
  const productLines = useMemo(() => input.split(/\r?\n/).filter((l) => l.trim() && !classifyForHint(l) && /\d/.test(l) && !/whatsapp|wa\.me|\+?\d[\d\s-]{8,14}\d|@/i.test(l)).length, [input]);
  const wantsShots = hints.some((h) => h.screenshotsHelp);

  const addFiles = useCallback((files: FileList | File[]) => {
    const next: Picked[] = [];
    for (const f of Array.from(files)) {
      const ok = /^image\/(png|jpe?g|webp|gif)$/.test(f.type) || /\.(csv|tsv|json|txt)$/i.test(f.name);
      if (!ok || f.size > 20 * 1024 * 1024) continue;
      next.push({ file: f, url: f.type.startsWith("image/") ? URL.createObjectURL(f) : null });
    }
    setPicked((p) => [...p, ...next].slice(0, 30));
  }, []);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const it of Array.from(items)) {
        if (it.kind === "file") {
          const f = it.getAsFile();
          if (f) files.push(new File([f], f.name && f.name !== "image.png" ? f.name : `screenshot-${Date.now()}.png`, { type: f.type }));
        }
      }
      if (files.length) {
        addFiles(files);
        e.preventDefault();
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addFiles]);

  const remove = (i: number) => setPicked((p) => p.filter((_, j) => j !== i));

  const submit = async () => {
    setError(null);
    if (!input.trim() && picked.length === 0) return setError("Paste at least one link or a product list, or attach screenshots.");
    setBusy(true);
    try {
      await onStart(
        input,
        { templateId: templateId || null, instructions: instructions || null, currency: currency || null, skipBuild, skipResearch, skipDiscovery },
        picked.map((p) => p.file),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const buttonLabel = busy ? "Starting…" : hints.length || picked.length ? `Build my store from ${[hints.length ? `${hints.length} link${hints.length === 1 ? "" : "s"}` : "", picked.length ? `${picked.length} file${picked.length === 1 ? "" : "s"}` : "", productLines ? `${productLines} product line${productLines === 1 ? "" : "s"}` : ""].filter(Boolean).join(" + ")}` : "Build my store";

  return (
    <section className="hero" id="top">
      <div className="pills">
        <span className="pill">⚡ Live in minutes</span>
        <span className="pill">🔗 Paste links or screenshots</span>
        <span className="pill">✏️ Edit anything later</span>
      </div>
      <h1>
        The fastest way to
        <br />
        launch your <span className="grad">online store</span>
      </h1>
      <p className="lead">Paste your TikTok Shop, Instagram, Shopee or Facebook links, drop in screenshots of your shop, and Nexova reads your brand and products, then puts your website live. Adjust inventory and everything else afterwards.</p>

      <div
        className={`composer ${dragging ? "dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={4}
          placeholder={"https://www.tiktok.com/@yourshop\nhttps://shopee.com.my/yourshop\nhttps://www.instagram.com/yourshop\n\n…or paste products: Matcha Latte Kit - RM 45\n…and your WhatsApp: +60123456789"}
          disabled={busy}
        />
        {hints.length > 0 && (
          <div className="hints">
            {hints.map((h) => (
              <span key={h.url} className={`hint-chip ${h.screenshotsHelp ? "warn" : ""}`} title={h.tip ?? h.url}>
                {h.label}
                {h.screenshotsHelp ? " · screenshots recommended" : " · ✓"}
              </span>
            ))}
          </div>
        )}

        <div className={`dropzone ${picked.length ? "has-files" : ""}`} onClick={() => fileInput.current?.click()} role="button" tabIndex={0}>
          <input ref={fileInput} type="file" multiple accept={ACCEPT} hidden onChange={(e) => e.target.files && addFiles(e.target.files)} />
          {picked.length === 0 ? (
            <div className="drop-empty">
              <strong>{wantsShots ? "Add screenshots of your shop (recommended for these links)" : "Add screenshots or a product CSV (optional)"}</strong>
              <span>Drag & drop, click, or paste from clipboard · TikTok Shop, Shopee, Lazada, Instagram grid, WhatsApp catalog, price lists · PNG/JPG/CSV</span>
            </div>
          ) : (
            <div className="thumbs" onClick={(e) => e.stopPropagation()}>
              {picked.map((p, i) => (
                <div key={i} className="thumb">
                  {p.url ? <img src={p.url} alt="" /> : <span className="thumb-file">{p.file.name.split(".").pop()?.toUpperCase()}</span>}
                  <button type="button" onClick={() => remove(i)} aria-label="Remove">
                    ×
                  </button>
                  <small>{p.file.name.length > 18 ? p.file.name.slice(0, 15) + "…" : p.file.name}</small>
                </div>
              ))}
              <button type="button" className="thumb thumb-add" onClick={() => fileInput.current?.click()}>
                + Add more
              </button>
            </div>
          )}
        </div>

        <div className="composer-row">
          <div className="chips">
            {PLATFORMS.map((p) => (
              <span key={p} className="chip">
                {p}
              </span>
            ))}
          </div>
          <div className="composer-actions">
            <button className="btn btn-ghost" onClick={() => setAdvanced(!advanced)} type="button">
              {advanced ? "Hide options" : "Options"}
            </button>
            <button className="btn btn-dark btn-lg" onClick={submit} disabled={busy}>
              {buttonLabel}
            </button>
          </div>
        </div>
        {advanced && (
          <div className="advanced">
            <label>
              Template
              <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">Let Nexova choose</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} — {t.style.tags.join(", ")}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Currency
              <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} placeholder="Auto (e.g. MYR)" maxLength={3} />
            </label>
            <label className="wide">
              Instructions for the AI
              <input value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="e.g. premium tone, focus on skincare, Malay copy" />
            </label>
            <label className="check">
              <input type="checkbox" checked={skipDiscovery} onChange={(e) => setSkipDiscovery(e.target.checked)} /> Do not look for my other channels (bio links, search)
            </label>
            <label className="check">
              <input type="checkbox" checked={skipResearch} onChange={(e) => setSkipResearch(e.target.checked)} /> Skip web research (faster, cheaper)
            </label>
            <label className="check">
              <input type="checkbox" checked={skipBuild} onChange={(e) => setSkipBuild(e.target.checked)} /> Only generate the store data (no build/publish)
            </label>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        {health?.offline && <p className="hint">No API key detected: the engine runs in offline mode with basic heuristics, and screenshots cannot be read. Add ANTHROPIC_API_KEY to .env for full Claude-powered reading, research and copy.</p>}
      </div>

      <ul className="tips">
        <li>
          <strong>Best results:</strong> paste 2–4 links to the same shop (profile + marketplace) and add a few screenshots of the pages bots cannot open.
        </li>
        <li>
          <strong>Screenshots that help most:</strong> your TikTok Shop / Shopee shop page, the product list with prices, 2–3 product pages, and anything showing your WhatsApp number.
        </li>
        <li>
          <strong>Have a spreadsheet?</strong> Upload a CSV export (Shopify, Shopee, WooCommerce). Its prices win over everything scraped.
        </li>
      </ul>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    { n: "1", title: "Paste links, drop screenshots", text: "TikTok Shop, Instagram, Shopee, Facebook, Lazada, Shopify, a product list or a CSV. Screenshots cover the pages that block bots." },
    { n: "2", title: "Nexova reads everything", text: "Pages are fetched through several strategies, your bio links are followed to find other channels, screenshots are read with vision, and Claude researches the gaps on the web." },
    { n: "3", title: "Your store goes live", text: "A React storefront is generated from a professional template with your theme, copy, catalog and WhatsApp checkout, plus a coverage report of what to verify." },
  ];
  return (
    <section className="how" id="how">
      <h2>How it works</h2>
      <div className="how-grid">
        {steps.map((s) => (
          <div key={s.n} className="how-card">
            <span className="how-n">{s.n}</span>
            <h3>{s.title}</h3>
            <p>{s.text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function RecentStores({ stores, onOpen, onRebuild }: { stores: StoreMeta[]; onOpen: (s: StoreMeta) => void; onRebuild: (s: StoreMeta) => void }) {
  return (
    <section className="recent" id="recent">
      <h2>Your stores</h2>
      <div className="store-list">
        {stores.map((s) => (
          <div key={s.slug} className="store-row">
            <div>
              <strong>{s.name}</strong>
              <span className="muted">
                /{s.slug} · {s.products} products · {s.templateId ?? "no template"}
              </span>
            </div>
            <div className="row-actions">
              <button className="btn btn-ghost" onClick={() => onRebuild(s)}>
                Rebuild
              </button>
              <button className="btn btn-dark" onClick={() => onOpen(s)} disabled={!s.siteUrl}>
                Open
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function BuildView({ job: initial, onNew, onRebuild, templates }: { job: Job; onNew: () => void; onRebuild: (slug: string, templateId: string | null) => Promise<void>; templates: TemplateManifest[] }) {
  const [job, setJob] = useState<Job>(initial);
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [templateId, setTemplateId] = useState<string>("");
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    setJob(initial);
    setProgress({});
    setLogs([]);
    setCoverage(null);
    const stop = api.events(
      initial.id,
      (e: JobEvent) => {
        if (e.type === "step") {
          setJob((j) => ({ ...j, steps: j.steps.map((s) => (s.name === e.step.name ? { ...s, ...e.step } : s)) }));
          if (e.step.name === "attachments" && e.step.status !== "running") api.coverage(initial.id).then(setCoverage).catch(() => {});
        } else if (e.type === "status") setJob((j) => ({ ...j, status: e.status }));
        else if (e.type === "usage") setJob((j) => ({ ...j, usage: e.usage }));
        else if (e.type === "progress") setProgress((p) => ({ ...p, [e.step]: e.message }));
        else if (e.type === "log") setLogs((l) => [...l.slice(-400), `${e.record.ts.slice(11, 19)} ${e.record.level.padEnd(5)} ${e.record.msg}`]);
        else if (e.type === "done") {
          setJob(e.job);
          api.coverage(initial.id).then(setCoverage).catch(() => {});
        } else if (e.type === "error") setJob((j) => ({ ...j, status: "failed", error: e.error }));
      },
      () => api.job(initial.id).then(setJob).catch(() => {}),
    );
    // Safety net: the record is the source of truth, so poll it while the job is active in case the
    // stream misses a beat (reconnects, hosted stream limits).
    const poll = setInterval(() => {
      api.job(initial.id)
        .then((latest) => {
          setJob((j) => (latest.updatedAt > j.updatedAt ? latest : j));
          if (latest.status !== "queued" && latest.status !== "running") {
            clearInterval(poll);
            api.coverage(initial.id).then(setCoverage).catch(() => {});
          }
        })
        .catch(() => {});
    }, 15_000);
    return () => {
      stop();
      clearInterval(poll);
    };
  }, [initial.id]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs, showLogs]);

  const done = job.status === "done";
  const failed = job.status === "failed" || job.status === "cancelled";
  const running = job.status === "running" || job.status === "queued";
  const activeStep = job.steps.find((s) => s.status === "running");
  const pct = useMemo(() => Math.round((job.steps.filter((s) => s.status === "done" || s.status === "skipped").length / job.steps.length) * 100), [job.steps]);
  const siteUrl = job.siteUrl ?? (done && job.slug ? `/s/${job.slug}/` : null);

  return (
    <section className="build">
      <div className="build-head">
        <div>
          <p className="eyebrow">{done ? "Your store is live" : failed ? "Something went wrong" : "Building your store"}</p>
          <h1>{done ? job.slug : activeStep ? STEP_LABELS[activeStep.name] : failed ? "Build stopped" : "Starting…"}</h1>
          {activeStep && progress[activeStep.name] && <p className="muted mono">{progress[activeStep.name]}</p>}
          {failed && job.error && <p className="error">{job.error}</p>}
        </div>
        <div className="build-meta">
          <span className="pill">{pct}%</span>
          <span className="pill">${job.usage.costUsd.toFixed(3)} · {job.usage.calls} AI calls</span>
          {running && (
            <button className="btn btn-ghost" onClick={() => api.cancel(job.id)}>
              Cancel
            </button>
          )}
        </div>
      </div>
      <div className="progress">
        <div className="progress-bar" style={{ width: `${pct}%` }} />
      </div>

      <div className="build-grid">
        <div className="steps-col">
          <ol className="steps">
            {job.steps.map((s) => (
              <Step key={s.name} step={s} progress={progress[s.name]} />
            ))}
          </ol>
          {coverage && <CoveragePanel coverage={coverage} />}
        </div>
        <div className="preview-col">
          {siteUrl ? (
            <>
              <div className="live-card">
                <div>
                  <strong>Live URL</strong>
                  <a href={siteUrl} target="_blank" rel="noreferrer" className="live-url">
                    {siteUrl}
                  </a>
                </div>
                <div className="row-actions">
                  <button className="btn btn-ghost" onClick={() => navigator.clipboard?.writeText(new URL(siteUrl, window.location.href).toString())}>
                    Copy link
                  </button>
                  <a className="btn btn-dark" href={siteUrl} target="_blank" rel="noreferrer">
                    Open store
                  </a>
                </div>
              </div>
              <iframe className="preview" src={siteUrl} title="Store preview" />
              <div className="after">
                <label>
                  Switch template
                  <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                    <option value="">Keep {job.templateId}</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="btn btn-ghost" onClick={() => job.slug && onRebuild(job.slug, templateId || null)}>
                  Rebuild
                </button>
                <a className="btn btn-ghost" href={`/api/stores/${job.slug}`} target="_blank" rel="noreferrer">
                  View store data
                </a>
                <button className="btn btn-dark" onClick={onNew}>
                  Build another
                </button>
              </div>
            </>
          ) : (
            <div className="preview-empty">
              {failed ? (
                <>
                  <p>The build stopped. Check the log below, fix the input and try again.</p>
                  <button className="btn btn-dark" onClick={onNew}>
                    Try again
                  </button>
                </>
              ) : (
                <>
                  <div className="spinner" />
                  <p className="muted">Your preview appears here as soon as the site is published.</p>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <button className="btn btn-ghost small" onClick={() => setShowLogs(!showLogs)}>
        {showLogs ? "Hide engine log" : `Show engine log (${logs.length})`}
      </button>
      {showLogs && <pre ref={logRef} className="log">{logs.join("\n") || "waiting for logs…"}</pre>}
    </section>
  );
}

function CoveragePanel({ coverage: c }: { coverage: Coverage }) {
  const pct = Math.round(c.score * 100);
  return (
    <div className="coverage">
      <div className="coverage-head">
        <strong>What we could read</strong>
        <span className={`pill ${pct >= 70 ? "pill-ok" : pct >= 40 ? "" : "pill-warn"}`}>{pct}% coverage</span>
      </div>
      <p className="muted small">
        {c.totals.products} products · {c.totals.withPrice} priced · {c.totals.withImages} with photos · {c.totals.profiles ? "profile ✓" : "no profile"} · {c.totals.contacts ? "contact ✓" : "no contact"}
        {c.attachments.total ? ` · ${c.attachments.total} attachment${c.attachments.total === 1 ? "" : "s"} (${c.attachments.products} products)` : ""}
      </p>
      <ul className="coverage-sources">
        {c.sources.map((s) => (
          <li key={s.url} className={`cov-${s.status}`}>
            <span className="cov-dot" />
            <span className="cov-label">
              {s.platform} {s.kind}
              {s.discovered ? " (found)" : ""}
            </span>
            <span className="cov-meta">
              {s.status} · {s.products} products{s.profile ? " · profile" : ""}{s.contacts ? " · contact" : ""}
              {s.strategies.length ? ` · via ${s.strategies.join(", ")}` : ""}
            </span>
          </li>
        ))}
      </ul>
      {c.recommendations.length > 0 && (
        <div className="coverage-reco">
          <strong>To make it more accurate</strong>
          <ul>
            {c.recommendations.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Step({ step, progress }: { step: StepState; progress?: string }) {
  const icon = step.status === "done" ? "✓" : step.status === "failed" ? "✕" : step.status === "skipped" ? "–" : step.status === "running" ? "●" : "○";
  return (
    <li className={`step step-${step.status}`}>
      <span className="step-icon">{icon}</span>
      <div>
        <strong>{STEP_LABELS[step.name] ?? step.name}</strong>
        <span className="step-msg">{step.status === "running" ? progress || "working…" : step.message || (step.status === "pending" ? "" : step.status)}</span>
      </div>
    </li>
  );
}
