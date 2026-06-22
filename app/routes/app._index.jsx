import { useEffect } from "react";
import { useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export default function Index() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate("/app/orders", { replace: true });
  }, [navigate]);

  return null;
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
