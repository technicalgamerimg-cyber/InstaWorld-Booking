import db from "../db.server";

const CITIES_URL = "https://one-be.instaworld.pk/logistics/cities";

// InstaWorld's serviceable-city list — public, unauthenticated, shared across all
// shops. Booking a shipment with a free-typed city (from the Shopify order's
// shipping address) fails whenever it doesn't exactly match one of these names
// (typos, extra address text, districts InstaWorld doesn't service). Letting
// merchants pick from this list instead guarantees an exact match.
export async function fetchInstaworldCities() {
  const res = await fetch(CITIES_URL, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`InstaWorld cities request failed: HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("InstaWorld cities response was not an array");
  return data
    .filter((c) => c && typeof c.id === "number" && typeof c.name === "string" && c.name.trim())
    .map((c) => ({ id: c.id, name: c.name.trim() }));
}

export async function syncCities() {
  const cities = await fetchInstaworldCities();

  const limit = 20;
  for (let i = 0; i < cities.length; i += limit) {
    const batch = cities.slice(i, i + limit);
    await Promise.all(batch.map((c) =>
      db.city.upsert({
        where: { id: c.id },
        update: { name: c.name },
        create: { id: c.id, name: c.name },
      })
    ));
  }

  return { synced: cities.length };
}

export function getCities() {
  return db.city.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } });
}
