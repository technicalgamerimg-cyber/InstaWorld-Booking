import { useState } from "react";
import { Outlet, useLoaderData, useRevalidator, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisProvider } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import OnboardingWizard from "../utils/OnboardingWizard";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  let isOnboarded = true; // fail-open: DB error must not trigger false onboarding loop
  try {
    const settings = await db.settings.findUnique({ where: { shop: session.shop } });
    isOnboarded = !!(settings?.instaworldApiKey);
  } catch (_) {}
  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", isOnboarded };
};

export default function App() {
  const { apiKey, isOnboarded } = useLoaderData();
  const revalidator = useRevalidator();
  const [optimistic, setOptimistic] = useState(false);

  const showWizard = !isOnboarded && !optimistic;

  const handleComplete = () => {
    setOptimistic(true);       // instant UX — no wait
    revalidator.revalidate();  // async server confirm — DB is truth
  };

  return (
    <ShopifyAppProvider embedded apiKey={apiKey}>
      <PolarisProvider i18n={enTranslations}>
        {showWizard ? (
          <OnboardingWizard onComplete={handleComplete} />
        ) : (
          <>
            <s-app-nav>
              <s-link href="/app/orders">Orders</s-link>
              <s-link href="/app/shipments">Shipments</s-link>
              <s-link href="/app/settings">Settings</s-link>
            </s-app-nav>
            <Outlet />
          </>
        )}
      </PolarisProvider>
    </ShopifyAppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
