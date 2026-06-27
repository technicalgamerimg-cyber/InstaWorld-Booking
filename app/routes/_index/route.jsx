import { redirect, Form, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>InstaWorld Booking</h1>
        <p className={styles.text}>
          Sync your Shopify orders and book InstaWorld courier pickups — all from your Shopify Admin.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Automated order sync</strong>. Import your latest Shopify orders in one click and keep your fulfillment pipeline up to date.
          </li>
          <li>
            <strong>One-click shipment booking</strong>. Create InstaWorld courier bookings directly from your order list with tracking numbers generated instantly.
          </li>
          <li>
            <strong>Live shipment tracking</strong>. Monitor shipment status and manage cancellations in real time, all within Shopify Admin.
          </li>
        </ul>
      </div>
    </div>
  );
}
