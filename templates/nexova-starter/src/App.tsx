import { useEffect, useMemo, useState } from "react";
import { assetUrl, checkoutUrl, featuredProducts, formatPrice, loadCart, placeholderImage, productBySlug, productsInCategory, saveCart, store, visibleProducts, type CartLine } from "./nexova";
import type { NxProduct } from "./nexova/types";

type Route = { name: "home" } | { name: "product"; slug: string } | { name: "category"; slug: string } | { name: "about" } | { name: "cart" } | { name: "search"; q: string } | { name: "all" };

function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, "");
  const [path, query] = h.split("?");
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "p" && parts[1]) return { name: "product", slug: decodeURIComponent(parts[1]) };
  if (parts[0] === "c" && parts[1]) return { name: "category", slug: decodeURIComponent(parts[1]) };
  if (parts[0] === "about") return { name: "about" };
  if (parts[0] === "cart") return { name: "cart" };
  if (parts[0] === "all") return { name: "all" };
  if (parts[0] === "search") return { name: "search", q: new URLSearchParams(query).get("q") ?? "" };
  return { name: "home" };
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parseRoute(window.location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

function useCart() {
  const [lines, setLines] = useState<CartLine[]>(() => loadCart());
  const update = (next: CartLine[]) => {
    setLines(next);
    saveCart(next);
  };
  const add = (productId: string, variantId: string | null, qty = 1) => {
    const idx = lines.findIndex((l) => l.productId === productId && l.variantId === variantId);
    if (idx >= 0) {
      const next = [...lines];
      next[idx] = { ...next[idx], qty: next[idx].qty + qty };
      update(next);
    } else update([...lines, { productId, variantId, qty }]);
  };
  const setQty = (i: number, qty: number) => update(lines.map((l, j) => (j === i ? { ...l, qty } : l)).filter((l) => l.qty > 0));
  const clear = () => update([]);
  const count = lines.reduce((n, l) => n + l.qty, 0);
  return { lines, add, setQty, clear, count };
}

export default function App() {
  const route = useRoute();
  const cart = useCart();
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);
  const addToCart = (p: NxProduct, variantId: string | null) => {
    cart.add(p.id, variantId);
    setToast(`${p.title} added to cart`);
  };
  return (
    <div className="nx-app" data-preset={store.theme.preset}>
      {store.pages.home.announcement && <div className="nx-announce">{store.pages.home.announcement}</div>}
      <Header cartCount={cart.count} />
      <main>
        {route.name === "home" && <Home onAdd={addToCart} />}
        {route.name === "product" && <ProductPage slug={route.slug} onAdd={addToCart} />}
        {route.name === "category" && <CategoryPage slug={route.slug} onAdd={addToCart} />}
        {route.name === "all" && <Listing title="All products" products={visibleProducts()} onAdd={addToCart} />}
        {route.name === "search" && <Listing title={`Search: ${route.q}`} products={visibleProducts().filter((p) => (p.title + " " + p.description + " " + p.tags.join(" ")).toLowerCase().includes(route.q.toLowerCase()))} onAdd={addToCart} />}
        {route.name === "about" && <AboutPage />}
        {route.name === "cart" && <CartPage cart={cart} />}
      </main>
      <Footer />
      {toast && <div className="nx-toast">{toast}</div>}
    </div>
  );
}

function Header({ cartCount }: { cartCount: number }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const cats = store.catalog.categories;
  return (
    <header className="nx-header">
      <div className="nx-container nx-header-row">
        <a href="#/" className="nx-logo" aria-label={store.brand.name}>
          {/* A logo file is usually the wordmark, so printing the name beside it duplicates it. */}
          {store.brand.logo ? (
            <img src={assetUrl(store.brand.logo)} alt={store.brand.name} className="nx-logo-mark" />
          ) : (
            <>
              {store.brand.avatar && <img src={assetUrl(store.brand.avatar)} alt="" className="nx-logo-round" />}
              <span>{store.brand.name}</span>
            </>
          )}
        </a>
        <nav className={`nx-nav ${open ? "open" : ""}`}>
          <a href="#/all">Shop</a>
          {cats.slice(0, 5).map((c) => (
            <a key={c.slug} href={`#/c/${c.slug}`}>
              {c.name}
            </a>
          ))}
          <a href="#/about">About</a>
        </nav>
        <form
          className="nx-search"
          onSubmit={(e) => {
            e.preventDefault();
            window.location.hash = `#/search?q=${encodeURIComponent(q)}`;
          }}
        >
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search products" />
        </form>
        <a href="#/cart" className="nx-cart-btn" aria-label="Cart">
          Cart{cartCount ? <span className="nx-badge">{cartCount}</span> : null}
        </a>
        <button className="nx-burger" onClick={() => setOpen(!open)} aria-label="Menu">
          ☰
        </button>
      </div>
    </header>
  );
}

function Home({ onAdd }: { onAdd: (p: NxProduct, v: string | null) => void }) {
  const home = store.pages.home;
  const hero = store.brand.heroImage ?? featuredProducts()[0]?.images[0] ?? null;
  return (
    <>
      <section className={`nx-hero ${hero ? "has-image" : ""}`}>
        <div className="nx-container nx-hero-grid">
          <div className="nx-hero-copy">
            {store.brand.tagline && <p className="nx-eyebrow">{store.brand.tagline}</p>}
            <h1>{home.heroTitle || store.brand.name}</h1>
            <p className="nx-lead">{home.heroSubtitle || store.brand.description}</p>
            <div className="nx-hero-actions">
              <a className="nx-btn nx-btn-primary" href="#/all">
                {home.heroCta || "Shop now"}
              </a>
              {store.social.whatsapp && (
                <a className="nx-btn nx-btn-ghost" href={store.social.whatsapp} target="_blank" rel="noreferrer">
                  Chat with us
                </a>
              )}
            </div>
          </div>
          {hero && (
            <div className="nx-hero-media">
              <img src={assetUrl(hero)} alt={hero.alt || store.brand.name} />
            </div>
          )}
        </div>
      </section>
      {home.sections.map((s, i) => (
        <Section key={i} type={s.type} title={s.title} subtitle={s.subtitle} onAdd={onAdd} />
      ))}
    </>
  );
}

function Section({ type, title, subtitle, onAdd }: { type: string; title: string; subtitle: string; onAdd: (p: NxProduct, v: string | null) => void }) {
  switch (type) {
    case "usp":
      return store.pages.home.usps.length ? (
        <section className="nx-section nx-usps">
          <div className="nx-container nx-usp-grid">
            {store.pages.home.usps.map((u, i) => (
              <div key={i} className="nx-usp">
                <h3>{u.title}</h3>
                <p>{u.text}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null;
    case "featured": {
      const items = featuredProducts();
      return items.length ? (
        <section className="nx-section">
          <div className="nx-container">
            <SectionHead title={title || "Featured"} subtitle={subtitle} link={{ href: "#/all", label: "View all" }} />
            <ProductGrid products={items} onAdd={onAdd} />
          </div>
        </section>
      ) : null;
    }
    case "categories":
      return store.catalog.categories.length > 1 ? (
        <section className="nx-section nx-alt">
          <div className="nx-container">
            <SectionHead title={title || "Shop by category"} subtitle={subtitle} />
            <div className="nx-cat-grid">
              {store.catalog.categories.map((c) => {
                const first = productsInCategory(c.slug).find((p) => p.images.length);
                const img = c.image ?? first?.images[0] ?? null;
                return (
                  <a key={c.slug} href={`#/c/${c.slug}`} className="nx-cat-card">
                    <div className="nx-cat-media">{img ? <img src={assetUrl(img)} alt={c.name} loading="lazy" /> : <div className="nx-cat-fallback">{c.name[0]}</div>}</div>
                    <span>{c.name}</span>
                    <small>{productsInCategory(c.slug).length} items</small>
                  </a>
                );
              })}
            </div>
          </div>
        </section>
      ) : null;
    case "story":
      return store.brand.story ? (
        <section className="nx-section">
          <div className="nx-container nx-story">
            <div>
              <SectionHead title={title || "Our story"} subtitle={subtitle} />
              <p className="nx-prose">{store.brand.story}</p>
              <a href="#/about" className="nx-link">
                Read more
              </a>
            </div>
            {store.brand.avatar && <img className="nx-story-img" src={assetUrl(store.brand.avatar)} alt={store.brand.name} loading="lazy" />}
          </div>
        </section>
      ) : null;
    case "testimonials":
      return store.pages.testimonials.length ? (
        <section className="nx-section nx-alt">
          <div className="nx-container">
            <SectionHead title={title || "What customers say"} subtitle={subtitle} />
            <div className="nx-testi-grid">
              {store.pages.testimonials.map((t, i) => (
                <blockquote key={i} className="nx-testi">
                  <p>“{t.text}”</p>
                  <footer>
                    {t.author}
                    {t.rating ? ` · ${"★".repeat(Math.round(t.rating))}` : ""}
                  </footer>
                </blockquote>
              ))}
            </div>
          </div>
        </section>
      ) : null;
    case "faq":
      return store.pages.faq.length ? (
        <section className="nx-section">
          <div className="nx-container nx-narrow">
            <SectionHead title={title || "FAQ"} subtitle={subtitle} />
            {store.pages.faq.map((f, i) => (
              <details key={i} className="nx-faq">
                <summary>{f.question}</summary>
                <p>{f.answer}</p>
              </details>
            ))}
          </div>
        </section>
      ) : null;
    case "socials":
      return <Socials title={title} />;
    case "newsletter":
      return (
        <section className="nx-section nx-alt">
          <div className="nx-container nx-narrow nx-center">
            <SectionHead title={title || "Stay in the loop"} subtitle={subtitle || "New drops and promos, straight to you."} />
            <form className="nx-newsletter" onSubmit={(e) => e.preventDefault()}>
              <input type="email" placeholder="Email address" />
              <button className="nx-btn nx-btn-primary" type="submit">
                Subscribe
              </button>
            </form>
          </div>
        </section>
      );
    default:
      return null;
  }
}

function Socials({ title }: { title: string }) {
  const entries = Object.entries(store.social).filter(([k, v]) => v && k !== "email") as Array<[string, string]>;
  if (!entries.length) return null;
  const labels: Record<string, string> = { tiktok: "TikTok", tiktokShop: "TikTok Shop", instagram: "Instagram", facebook: "Facebook", shopee: "Shopee", lazada: "Lazada", whatsapp: "WhatsApp", telegram: "Telegram", youtube: "YouTube", x: "X", website: "Website" };
  return (
    <section className="nx-section nx-center">
      <div className="nx-container">
        <SectionHead title={title || "Follow along"} subtitle="" />
        <div className="nx-social-row">
          {entries.map(([k, v]) => (
            <a key={k} href={v} target="_blank" rel="noreferrer" className="nx-chip">
              {labels[k] ?? k}
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

function SectionHead({ title, subtitle, link }: { title: string; subtitle?: string; link?: { href: string; label: string } }) {
  return (
    <div className="nx-section-head">
      <div>
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {link && (
        <a href={link.href} className="nx-link">
          {link.label}
        </a>
      )}
    </div>
  );
}

function ProductGrid({ products, onAdd }: { products: NxProduct[]; onAdd: (p: NxProduct, v: string | null) => void }) {
  return (
    <div className="nx-grid">
      {products.map((p) => (
        <ProductCard key={p.id} p={p} onAdd={onAdd} />
      ))}
    </div>
  );
}

function ProductCard({ p, onAdd }: { p: NxProduct; onAdd: (p: NxProduct, v: string | null) => void }) {
  const img = p.images[0];
  const out = p.inventory.status === "out_of_stock";
  return (
    <article className="nx-card">
      <a href={`#/p/${p.slug}`} className="nx-card-media">
        <img src={img ? assetUrl(img) : placeholderImage(p.title)} alt={img?.alt || p.title} loading="lazy" />
        {p.compareAtPrice && <span className="nx-tag">Sale</span>}
        {out && <span className="nx-tag nx-tag-muted">Sold out</span>}
      </a>
      <div className="nx-card-body">
        <a href={`#/p/${p.slug}`} className="nx-card-title">
          {p.title}
        </a>
        {p.shortDescription && <p className="nx-card-desc">{p.shortDescription}</p>}
        <div className="nx-card-row">
          <Price p={p} />
          <button className="nx-btn nx-btn-small" disabled={out} onClick={() => (p.variants.length > 1 ? (window.location.hash = `#/p/${p.slug}`) : onAdd(p, p.variants[0]?.id ?? null))}>
            {p.variants.length > 1 ? "Choose" : "Add"}
          </button>
        </div>
      </div>
    </article>
  );
}

function Price({ p, variantId }: { p: NxProduct; variantId?: string | null }) {
  const v = variantId ? p.variants.find((x) => x.id === variantId) : null;
  const price = v?.price ?? p.price;
  const compare = v?.compareAtPrice ?? p.compareAtPrice;
  if (!price.amount) return <span className="nx-price nx-muted">Ask for price</span>;
  return (
    <span className="nx-price">
      {formatPrice(price)}
      {compare && compare.amount > price.amount && <s>{formatPrice(compare)}</s>}
    </span>
  );
}

function ProductPage({ slug, onAdd }: { slug: string; onAdd: (p: NxProduct, v: string | null) => void }) {
  const p = productBySlug(slug);
  const [img, setImg] = useState(0);
  const [variantId, setVariantId] = useState<string | null>(null);
  useEffect(() => {
    setImg(0);
    setVariantId(p?.variants[0]?.id ?? null);
  }, [slug]);
  if (!p) return <NotFound />;
  const images = p.images.length ? p.images : [];
  const out = p.inventory.status === "out_of_stock";
  const related = visibleProducts().filter((x) => x.id !== p.id && x.categories.some((c) => p.categories.includes(c))).slice(0, 4);
  return (
    <section className="nx-section">
      <div className="nx-container">
        <nav className="nx-crumbs">
          <a href="#/">Home</a> / <a href="#/all">Shop</a> / <span>{p.title}</span>
        </nav>
        <div className="nx-pdp">
          <div className="nx-pdp-media">
            <div className="nx-pdp-main">
              <img src={images[img] ? assetUrl(images[img]) : placeholderImage(p.title)} alt={images[img]?.alt || p.title} />
            </div>
            {images.length > 1 && (
              <div className="nx-thumbs">
                {images.map((im, i) => (
                  <button key={i} className={i === img ? "active" : ""} onClick={() => setImg(i)}>
                    <img src={assetUrl(im)} alt="" loading="lazy" />
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="nx-pdp-info">
            <h1>{p.title}</h1>
            <div className="nx-pdp-price">
              <Price p={p} variantId={variantId} />
            </div>
            {(p.rating || p.soldCount) && (
              <p className="nx-muted">
                {p.rating ? `★ ${p.rating.average.toFixed(1)}${p.rating.count ? ` (${p.rating.count})` : ""}` : ""}
                {p.rating && p.soldCount ? " · " : ""}
                {p.soldCount ? `${p.soldCount} sold` : ""}
              </p>
            )}
            {p.variants.length > 1 && (
              <div className="nx-variants">
                {p.variants.map((v) => (
                  <button key={v.id} className={`nx-chip ${v.id === variantId ? "active" : ""}`} onClick={() => setVariantId(v.id)} disabled={v.inventory.status === "out_of_stock"}>
                    {v.title}
                  </button>
                ))}
              </div>
            )}
            <div className="nx-pdp-actions">
              <button className="nx-btn nx-btn-primary" disabled={out} onClick={() => onAdd(p, variantId)}>
                {out ? "Sold out" : "Add to cart"}
              </button>
              <BuyNow p={p} variantId={variantId} />
            </div>
            {p.description && <p className="nx-prose">{p.description}</p>}
            {Object.keys(p.attributes).length > 0 && (
              <dl className="nx-attrs">
                {Object.entries(p.attributes).map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            )}
            {store.commerce.shipping.note && <p className="nx-muted nx-small">{store.commerce.shipping.note}</p>}
          </div>
        </div>
        {related.length > 0 && (
          <div className="nx-related">
            <SectionHead title="You may also like" />
            <ProductGrid products={related} onAdd={onAdd} />
          </div>
        )}
      </div>
    </section>
  );
}

function BuyNow({ p, variantId }: { p: NxProduct; variantId: string | null }) {
  const target = useMemo(() => checkoutUrl([{ productId: p.id, variantId, qty: 1 }]), [p.id, variantId]);
  if (!target) return null;
  return (
    <a className="nx-btn nx-btn-ghost" href={target.href} target="_blank" rel="noreferrer">
      {target.label}
    </a>
  );
}

function CategoryPage({ slug, onAdd }: { slug: string; onAdd: (p: NxProduct, v: string | null) => void }) {
  const cat = store.catalog.categories.find((c) => c.slug === slug);
  if (!cat) return <NotFound />;
  return <Listing title={cat.name} subtitle={cat.description} products={productsInCategory(slug)} onAdd={onAdd} />;
}

function Listing({ title, subtitle, products, onAdd }: { title: string; subtitle?: string; products: NxProduct[]; onAdd: (p: NxProduct, v: string | null) => void }) {
  const [sort, setSort] = useState("featured");
  const sorted = [...products].sort((a, b) => (sort === "price-asc" ? a.price.amount - b.price.amount : sort === "price-desc" ? b.price.amount - a.price.amount : sort === "name" ? a.title.localeCompare(b.title) : Number(b.featured) - Number(a.featured)));
  return (
    <section className="nx-section">
      <div className="nx-container">
        <div className="nx-section-head">
          <div>
            <h1>{title}</h1>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
            <option value="featured">Featured</option>
            <option value="price-asc">Price: low to high</option>
            <option value="price-desc">Price: high to low</option>
            <option value="name">Name</option>
          </select>
        </div>
        {sorted.length ? <ProductGrid products={sorted} onAdd={onAdd} /> : <p className="nx-muted">No products here yet.</p>}
      </div>
    </section>
  );
}

function AboutPage() {
  const b = store.brand;
  return (
    <section className="nx-section">
      <div className="nx-container nx-narrow">
        <h1>{store.pages.about.title || "About us"}</h1>
        <p className="nx-prose">{store.pages.about.body || b.story || b.description}</p>
        {(b.contact.email || b.contact.phone || b.contact.address || b.contact.whatsapp) && (
          <div className="nx-contact">
            <h2>{store.pages.contact.title || "Contact"}</h2>
            {b.contact.whatsapp && (
              <p>
                WhatsApp: <a href={`https://wa.me/${b.contact.whatsapp}`}>+{b.contact.whatsapp}</a>
              </p>
            )}
            {b.contact.email && (
              <p>
                Email: <a href={`mailto:${b.contact.email}`}>{b.contact.email}</a>
              </p>
            )}
            {b.contact.phone && <p>Phone: {b.contact.phone}</p>}
            {b.contact.address && <p>{b.contact.address}</p>}
          </div>
        )}
        {store.commerce.policies.returns && (
          <>
            <h2>Returns</h2>
            <p className="nx-prose">{store.commerce.policies.returns}</p>
          </>
        )}
      </div>
    </section>
  );
}

function CartPage({ cart }: { cart: ReturnType<typeof useCart> }) {
  const rows = cart.lines
    .map((l, i) => {
      const p = store.catalog.products.find((x) => x.id === l.productId);
      if (!p) return null;
      const v = l.variantId ? p.variants.find((x) => x.id === l.variantId) : null;
      const price = v?.price ?? p.price;
      return { i, l, p, v, price };
    })
    .filter((r): r is NonNullable<typeof r> => !!r);
  const total = rows.reduce((n, r) => n + r.price.amount * r.l.qty, 0);
  const target = checkoutUrl(cart.lines);
  return (
    <section className="nx-section">
      <div className="nx-container nx-narrow">
        <h1>Your cart</h1>
        {rows.length === 0 ? (
          <p className="nx-muted">
            Your cart is empty. <a href="#/all">Browse products</a>
          </p>
        ) : (
          <>
            <div className="nx-cart">
              {rows.map((r) => (
                <div key={r.i} className="nx-cart-row">
                  <img src={r.p.images[0] ? assetUrl(r.p.images[0]) : placeholderImage(r.p.title)} alt="" />
                  <div className="nx-cart-info">
                    <a href={`#/p/${r.p.slug}`}>{r.p.title}</a>
                    {r.v && <small>{r.v.title}</small>}
                    <span>{formatPrice(r.price)}</span>
                  </div>
                  <div className="nx-qty">
                    <button onClick={() => cart.setQty(r.i, r.l.qty - 1)}>−</button>
                    <span>{r.l.qty}</span>
                    <button onClick={() => cart.setQty(r.i, r.l.qty + 1)}>+</button>
                  </div>
                </div>
              ))}
            </div>
            <div className="nx-cart-total">
              <span>Total</span>
              <strong>{formatPrice({ amount: total, currency: store.commerce.currency })}</strong>
            </div>
            <div className="nx-pdp-actions">
              {target ? (
                <a className="nx-btn nx-btn-primary" href={target.href} target="_blank" rel="noreferrer">
                  {target.label}
                </a>
              ) : (
                <p className="nx-muted">Checkout is not configured yet. Contact us to order.</p>
              )}
              <button className="nx-btn nx-btn-ghost" onClick={cart.clear}>
                Clear cart
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function NotFound() {
  return (
    <section className="nx-section">
      <div className="nx-container nx-center">
        <h1>Not found</h1>
        <a href="#/" className="nx-link">
          Back home
        </a>
      </div>
    </section>
  );
}

function Footer() {
  const b = store.brand;
  const entries = Object.entries(store.social).filter(([, v]) => v) as Array<[string, string]>;
  return (
    <footer className="nx-footer">
      <div className="nx-container nx-footer-grid">
        <div>
          <strong>{b.name}</strong>
          <p className="nx-muted">{b.description}</p>
        </div>
        <div>
          <strong>Shop</strong>
          <a href="#/all">All products</a>
          {store.catalog.categories.map((c) => (
            <a key={c.slug} href={`#/c/${c.slug}`}>
              {c.name}
            </a>
          ))}
        </div>
        <div>
          <strong>Info</strong>
          <a href="#/about">About</a>
          <a href="#/cart">Cart</a>
          {entries.map(([k, v]) => (
            <a key={k} href={v} target="_blank" rel="noreferrer">
              {k === "tiktokShop" ? "TikTok Shop" : k.charAt(0).toUpperCase() + k.slice(1)}
            </a>
          ))}
        </div>
      </div>
      <div className="nx-container nx-footer-bottom">
        <span>
          © {new Date().getFullYear()} {b.name}
        </span>
        <span>Built with Nexova</span>
      </div>
    </footer>
  );
}
