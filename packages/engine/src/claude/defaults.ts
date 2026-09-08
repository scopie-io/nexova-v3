/**
 * Deterministic defaults for everything the normalization step no longer asks Claude for.
 *
 * Structured outputs compile the schema into a grammar, and a schema wide enough to cover facts
 * *and* design *and* copy is rejected ("the compiled grammar is too large"). So normalization
 * returns facts only, these defaults make the store presentable on their own, and the enrich step
 * refines them. If enrich fails, the store still launches with a coherent look.
 */
import type { Theme } from "../schema/store-spec.js";

export interface Palette {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  surface: string;
  text: string;
  preset: string;
  heading: string;
  body: string;
  radius: Theme["radius"];
}

export const PALETTES: Record<string, Palette> = {
  beauty: { primary: "#2b2b2b", secondary: "#6b7280", accent: "#e0658d", background: "#ffffff", surface: "#faf6f7", text: "#2b2b2b", preset: "luxe", heading: "Playfair Display", body: "Inter", radius: "sm" },
  fashion: { primary: "#111111", secondary: "#6b7280", accent: "#c9a26b", background: "#ffffff", surface: "#f7f6f4", text: "#111111", preset: "editorial", heading: "DM Serif Display", body: "Inter", radius: "sm" },
  food: { primary: "#3b2a1a", secondary: "#8a7a6a", accent: "#e07a1f", background: "#fffdf9", surface: "#f7f1e8", text: "#3b2a1a", preset: "organic", heading: "Fraunces", body: "Inter", radius: "md" },
  electronics: { primary: "#0f172a", secondary: "#64748b", accent: "#2563eb", background: "#ffffff", surface: "#f1f5f9", text: "#0f172a", preset: "tech", heading: "Space Grotesk", body: "Inter", radius: "md" },
  home: { primary: "#2f3e34", secondary: "#7d8a80", accent: "#b08968", background: "#fffefb", surface: "#f4f1ea", text: "#2f3e34", preset: "minimal", heading: "Cormorant Garamond", body: "Inter", radius: "sm" },
  handmade: { primary: "#3f3128", secondary: "#8a7767", accent: "#d97706", background: "#fffdf8", surface: "#f6efe6", text: "#3f3128", preset: "playful", heading: "Nunito", body: "Nunito", radius: "lg" },
  kids: { primary: "#1e3a8a", secondary: "#64748b", accent: "#f59e0b", background: "#ffffff", surface: "#f0f6ff", text: "#1e3a8a", preset: "playful", heading: "Baloo 2", body: "Nunito", radius: "full" },
  pets: { primary: "#1f2937", secondary: "#6b7280", accent: "#10b981", background: "#ffffff", surface: "#f0fdf4", text: "#1f2937", preset: "playful", heading: "Nunito", body: "Nunito", radius: "lg" },
  sports: { primary: "#0b0b0f", secondary: "#6b7280", accent: "#22c55e", background: "#ffffff", surface: "#f4f4f5", text: "#0b0b0f", preset: "bold", heading: "Oswald", body: "Inter", radius: "sm" },
  health: { primary: "#14532d", secondary: "#6b7280", accent: "#22c55e", background: "#ffffff", surface: "#f0fdf4", text: "#14532d", preset: "clean", heading: "Inter", body: "Inter", radius: "md" },
  accessories: { primary: "#1c1917", secondary: "#78716c", accent: "#a8763e", background: "#ffffff", surface: "#f5f5f4", text: "#1c1917", preset: "editorial", heading: "DM Serif Display", body: "Inter", radius: "sm" },
  digital: { primary: "#0f172a", secondary: "#64748b", accent: "#7c3aed", background: "#ffffff", surface: "#f5f3ff", text: "#0f172a", preset: "tech", heading: "Space Grotesk", body: "Inter", radius: "md" },
  other: { primary: "#111111", secondary: "#6b7280", accent: "#7c3aed", background: "#ffffff", surface: "#f6f6f7", text: "#111111", preset: "clean", heading: "Inter", body: "Inter", radius: "md" },
};

export function paletteFor(industry: string): Palette {
  return PALETTES[industry.trim().toLowerCase()] ?? PALETTES.other;
}

export function defaultTheme(industry: string): Theme {
  const p = paletteFor(industry);
  return {
    preset: p.preset,
    mode: "light",
    colors: { primary: p.primary, secondary: p.secondary, accent: p.accent, background: p.background, surface: p.surface, text: p.text, muted: p.secondary },
    fonts: { heading: p.heading, body: p.body },
    radius: p.radius,
  };
}

export interface DefaultCopyInput {
  brandName: string;
  tagline: string;
  description: string;
  industry: string;
  hasWhatsapp: boolean;
  shippingNote: string;
  returnsPolicy: string;
}

export function defaultUsps(input: DefaultCopyInput): Array<{ title: string; text: string }> {
  return [
    { title: "Straight from us", text: `Every order is packed and sent by the ${input.brandName} team.` },
    { title: "Easy ordering", text: input.hasWhatsapp ? "Pick what you want and confirm your order with us on WhatsApp." : "Browse, pick your favourites and check out in minutes." },
    { title: "Stay in the loop", text: "New drops and promotions are announced on our social channels first." },
  ];
}

export function defaultFaq(input: DefaultCopyInput): Array<{ question: string; answer: string }> {
  return [
    { question: "How do I place an order?", answer: input.hasWhatsapp ? "Tap Buy on any product and we will confirm your order with you on WhatsApp." : "Add what you want to your cart and follow the checkout steps." },
    { question: "How long does delivery take?", answer: input.shippingNote || "Orders are usually packed within 1-3 working days. Delivery time then depends on your location." },
    { question: "Can I return or exchange an item?", answer: input.returnsPolicy || "Contact us within 7 days of receiving your order and we will help you sort it out." },
    { question: "How do I contact you?", answer: input.hasWhatsapp ? "Message us on WhatsApp using the button on any product page." : "Use the contact details on our About page and we will get back to you." },
  ];
}

export function defaultHomeCopy(input: DefaultCopyInput): { heroTitle: string; heroSubtitle: string; heroCta: string } {
  return {
    heroTitle: input.tagline || input.brandName,
    heroSubtitle: input.description || `Browse everything ${input.brandName} sells, in one place.`,
    heroCta: "Shop now",
  };
}

export function defaultAbout(input: DefaultCopyInput): { title: string; body: string } {
  return {
    title: "About us",
    body: input.description || `${input.brandName} sells through social media and now has its own store, so you can see everything in one place.`,
  };
}
