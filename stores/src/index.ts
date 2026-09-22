import { storeUrlIsSafe } from "./urls";
export type StoreLaunchMode = "assisted" | "self_service";

export type StoreStatus =
  | "draft"
  | "onboarding"
  | "review"
  | "active"
  | "suspended"
  | "archived";

export type StoreMemberRole =
  | "owner"
  | "admin"
  | "designer"
  | "catalog_manager"
  | "order_manager"
  | "viewer";

export type StoreMemberCapability =
  | "manage_catalog"
  | "manage_commercial_terms"
  | "manage_members"
  | "manage_theme"
  | "publish_theme"
  | "request_payout"
  | "submit_artwork"
  | "view_orders";

const STORE_ROLE_CAPABILITIES: Record<
  StoreMemberRole,
  ReadonlySet<StoreMemberCapability>
> = {
  admin: new Set([
    "manage_catalog",
    "manage_members",
    "manage_theme",
    "publish_theme",
    "request_payout",
    "submit_artwork",
    "view_orders",
  ]),
  catalog_manager: new Set(["manage_catalog"]),
  designer: new Set(["manage_theme", "submit_artwork"]),
  order_manager: new Set(["view_orders"]),
  owner: new Set([
    "manage_catalog",
    "manage_members",
    "manage_theme",
    "publish_theme",
    "request_payout",
    "submit_artwork",
    "view_orders",
  ]),
  viewer: new Set(["view_orders"]),
};

export const storeMemberCan = (
  role: StoreMemberRole,
  capability: StoreMemberCapability,
) => STORE_ROLE_CAPABILITIES[role].has(capability);

export const storeOwnerReviewIssues = (
  issues: StoreLaunchReadiness["issues"],
) =>
  issues.filter(
    (issue) =>
      !(
        [
          "artwork_provider_mapping_missing",
          "catalog_cost_missing",
          "catalog_inventory_missing",
          "catalog_media_unverified",
          "catalog_production_facts_missing",
          "catalog_provider_sku_missing",
          "earnings_policy_missing",
          "fulfillment_provider_missing",
          "launch_simulation_failed",
          "payment_missing",
        ] as StoreLaunchReadiness["issues"]
      ).includes(issue),
  );

export type StoreDomainKind = "default" | "custom";
export type StoreDomainStatus =
  | "pending"
  | "verifying"
  | "active"
  | "failed"
  | "disabled";

export type StoreNavigationItem = {
  label: string;
  href: string;
  children?: StoreNavigationItem[];
};

export type StorePageSection = {
  id: string;
  type: string;
  enabled: boolean;
  settings: Record<string, unknown>;
};

export type StoreHeroSlide = {
  id: string;
  headline: string;
  subheading?: string;
  imageUrl?: string;
  imageAlt?: string;
  callToAction?: { label: string; href: string };
};

export type StoreTheme = {
  headerText?: string;
  footerText?: string;
  templateKey: string;
  logoUrl?: string;
  faviconUrl?: string;
  colors: {
    background: string;
    foreground: string;
    primary: string;
    secondary: string;
    accent: string;
  };
  fonts: {
    body: string;
    heading: string;
  };
  hero: {
    /** Additional slides after the primary hero; no automatic rotation. */
    slides?: StoreHeroSlide[];
    imageAlt?: string;
    headline: string;
    subheading?: string;
    imageUrl?: string;
    callToAction?: { label: string; href: string };
  };
  navigation: StoreNavigationItem[];
  sections: StorePageSection[];
};

export const STORE_SECTION_TYPES = [
  "collection",
  "trust",
  "how-it-works",
  "bulk",
] as const;
export const STORE_TEMPLATE_KEYS = ["classic", "editorial", "catalog"] as const;

/**
 * Store-owner earnings deliberately have no implicit default. A store cannot
 * launch until CBS records the commercial terms agreed with its owner.
 */
export type StoreEarningsPolicy =
  | {
      mode: "fixed_per_item";
      currency: string;
      amountCents: number;
    }
  | {
      mode: "percentage_of_sale";
      basisPoints: number;
    }
  | {
      mode: "percentage_of_net_margin";
      basisPoints: number;
    };

export type StoreLaunchReadiness = {
  ready: boolean;
  issues: Array<
    | "artwork_missing"
    | "artwork_provider_mapping_missing"
    | "catalog_cost_missing"
    | "catalog_inventory_missing"
    | "catalog_media_unverified"
    | "catalog_missing"
    | "catalog_production_facts_missing"
    | "catalog_provider_sku_missing"
    | "domain_missing"
    | "earnings_policy_missing"
    | "fulfillment_provider_missing"
    | "launch_simulation_failed"
    | "owner_missing"
    | "payment_missing"
    | "theme_invalid"
  >;
};

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CSS_COLOR = /^(#[\da-f]{3,8}|[a-z][a-z\d-]*|(?:rgb|hsl)a?\([^)]*\))$/iu;
const FONT_NAME = /^[\p{L}\p{N} .,+'-]{1,100}$/u;

export const calculateStoreEarningsCents = (input: {
  policy: StoreEarningsPolicy;
  quantity: number;
  saleCents: number;
  productionCents: number;
  paymentFeeCents: number;
  refundCents?: number;
}) => {
  const refundedSale = Math.max(0, input.saleCents - (input.refundCents ?? 0));
  const base =
    input.policy.mode === "percentage_of_net_margin"
      ? Math.max(
          0,
          refundedSale - input.productionCents - input.paymentFeeCents,
        )
      : refundedSale;
  const amount =
    input.policy.mode === "fixed_per_item"
      ? input.policy.amountCents * input.quantity
      : Math.floor((base * input.policy.basisPoints) / 10_000);

  return Math.max(0, Math.min(amount, refundedSale));
};

export type StoreEarningLedgerKind =
  | "accrual"
  | "adjustment"
  | "chargeback"
  | "payout_hold"
  | "payout_reversal"
  | "refund";

export type StoreEarningBalanceEntry = {
  amountCents: number;
  availableAt: Date;
  kind: StoreEarningLedgerKind;
};

export const defaultStoreHostname = (slug: string, platformDomain: string) => {
  const normalizedSlug = normalizeStoreSlug(slug);
  const normalizedDomain = normalizeStoreHostname(platformDomain);
  if (!storeSlugIsValid(normalizedSlug) || !normalizedDomain)
    throw new Error("A valid store slug and platform domain are required");

  return `${normalizedSlug}.${normalizedDomain}`;
};
export const normalizeStoreHostname = (value: string) => {
  const candidate = value.trim().toLowerCase();
  if (!candidate) return "";
  try {
    const parsed = new URL(
      candidate.includes("://") ? candidate : `https://${candidate}`,
    );

    return parsed.hostname.replace(/\.$/u, "");
  } catch {
    return "";
  }
};
export const normalizeStoreSlug = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/(^-|-$)/gu, "");
export const storeEarningBalance = (
  entries: StoreEarningBalanceEntry[],
  now = new Date(),
) => {
  const pendingCents = entries.reduce(
    (sum, entry) =>
      entry.amountCents > 0 && entry.availableAt > now
        ? sum + entry.amountCents
        : sum,
    0,
  );
  const maturedCents = entries.reduce(
    (sum, entry) =>
      entry.amountCents <= 0 || entry.availableAt <= now
        ? sum + entry.amountCents
        : sum,
    0,
  );

  return {
    availableCents: Math.max(0, maturedCents),
    balanceCents: maturedCents + pendingCents,
    pendingCents,
  };
};

export const storeEarningsReversal = (input: {
  currentEarningsCents: number;
  nextEarningsCents: number;
}) =>
  -Math.max(
    0,
    input.currentEarningsCents - Math.max(0, input.nextEarningsCents),
  );
export const storeLaunchReadiness = (input: {
  activeArtworkCount: number;
  activeDomainCount: number;
  activeOwnerCount: number;
  activeCatalogCount: number;
  earningsPolicy: StoreEarningsPolicy | null;
  paymentConfigured: boolean;
  theme: StoreTheme;
  operationalIssues?: StoreLaunchReadiness["issues"];
}): StoreLaunchReadiness => {
  const issues: StoreLaunchReadiness["issues"] = [];
  if (input.activeDomainCount < 1) issues.push("domain_missing");
  if (input.activeOwnerCount < 1) issues.push("owner_missing");
  if (input.activeCatalogCount < 1) issues.push("catalog_missing");
  if (input.activeArtworkCount < 1) issues.push("artwork_missing");
  if (!input.earningsPolicy) issues.push("earnings_policy_missing");
  if (!input.paymentConfigured) issues.push("payment_missing");
  if (!storeThemeIsValid(input.theme)) issues.push("theme_invalid");
  for (const issue of input.operationalIssues ?? [])
    if (!issues.includes(issue)) issues.push(issue);

  return { issues, ready: issues.length === 0 };
};
export const storeSlugIsValid = (value: string) => SLUG.test(value);
export const storeThemeIssues = (theme: StoreTheme) => {
  const issues: string[] = [];
  for (const value of [theme.headerText, theme.footerText])
    if (
      value !== undefined &&
      (typeof value !== "string" || value.length > 2000)
    )
      issues.push("Header and footer text must be at most 2,000 characters.");
  if (!STORE_TEMPLATE_KEYS.includes(theme.templateKey as never))
    issues.push("Choose a supported storefront template.");
  if (!FONT_NAME.test(theme.fonts.body) || !FONT_NAME.test(theme.fonts.heading))
    issues.push("Use valid heading and body font names.");
  if (!theme.hero.headline.trim()) issues.push("Add a hero headline.");
  if (theme.hero.slides !== undefined) {
    const slides = theme.hero.slides;
    if (!Array.isArray(slides) || slides.length > 7) {
      issues.push(
        "Use at most eight homepage slides, including the primary slide.",
      );
    } else {
      const ids = new Set<string>(["primary"]);
      for (const slide of slides) {
        if (
          !slide ||
          typeof slide !== "object" ||
          typeof slide.id !== "string" ||
          !slide.id.trim() ||
          slide.id.length > 120 ||
          ids.has(slide.id)
        ) {
          issues.push("Homepage slides need unique identities.");
          continue;
        }
        ids.add(slide.id);
        if (
          typeof slide.headline !== "string" ||
          !slide.headline.trim() ||
          slide.headline.length > 200
        )
          issues.push("Each slide needs a headline of at most 200 characters.");
        if (
          slide.subheading !== undefined &&
          (typeof slide.subheading !== "string" ||
            slide.subheading.length > 1000)
        )
          issues.push("Slide descriptions must be at most 1,000 characters.");
        if (
          slide.imageAlt !== undefined &&
          (typeof slide.imageAlt !== "string" || slide.imageAlt.length > 500)
        )
          issues.push(
            "Slide image descriptions must be at most 500 characters.",
          );
        if (
          slide.imageUrl &&
          (typeof slide.imageUrl !== "string" ||
            !storeUrlIsSafe(slide.imageUrl))
        )
          issues.push("Use a safe slide image URL.");
        if (
          slide.callToAction &&
          (typeof slide.callToAction.label !== "string" ||
            !slide.callToAction.label.trim() ||
            slide.callToAction.label.length > 120 ||
            typeof slide.callToAction.href !== "string" ||
            !storeUrlIsSafe(slide.callToAction.href))
        )
          issues.push("Complete each slide button label and safe destination.");
      }
    }
  }

  if (theme.logoUrl && !storeUrlIsSafe(theme.logoUrl))
    issues.push("Use a secure logo URL or an uploaded logo.");
  if (theme.faviconUrl && !storeUrlIsSafe(theme.faviconUrl))
    issues.push("Use a secure favicon URL or an uploaded favicon.");
  if (theme.hero.imageUrl && !storeUrlIsSafe(theme.hero.imageUrl))
    issues.push("Use a secure hero image URL or an uploaded image.");
  if (
    theme.hero.callToAction &&
    (!theme.hero.callToAction.label.trim() ||
      !storeUrlIsSafe(theme.hero.callToAction.href))
  )
    issues.push("Complete the hero button label and safe destination.");
  if (
    Object.values(theme.colors).some((color) => !CSS_COLOR.test(color.trim()))
  )
    issues.push("Choose valid colors for every theme color field.");
  const navigationIsValid = (items: StoreNavigationItem[]): boolean =>
    items.every(
      (item) =>
        item.label.trim() &&
        storeUrlIsSafe(item.href) &&
        (!item.children || navigationIsValid(item.children)),
    );

  if (!navigationIsValid(theme.navigation))
    issues.push("Correct every navigation label and destination.");
  if (
    new Set(theme.sections.map(({ id }) => id)).size !== theme.sections.length
  )
    issues.push("Homepage sections must have unique identities.");
  if (
    !theme.sections.every(
      ({ id, type }) =>
        id.trim() && STORE_SECTION_TYPES.includes(type as never),
    )
  )
    issues.push("Remove unsupported or incomplete homepage sections.");

  return issues;
};
export const storeThemeIsValid = (theme: StoreTheme) =>
  storeThemeIssues(theme).length === 0;

export * from "./releases";
export * from "./policies";
export {
  storeMockups,
  parseStoreMockupOverrides,
  type StoreMockup,
  type StoreMockupOverride,
} from "./mockups";

export { isManualDecorator } from "./policies";

export * from "./address";
