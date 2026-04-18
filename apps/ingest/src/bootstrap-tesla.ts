import {
  createFeedConfigDb,
  getPool,
  listFeedConfigsDb,
  updateFeedConfigDb,
  usingDatabase,
} from "@adhoc/shared/db";

const TESLA_STATIC = {
  source: "mobilithek" as const,
  cpoId: "tesla",
  name: "Tesla Static AFIR",
  mode: "pull" as const,
  type: "static" as const,
  subscriptionId: "970069105264459776",
  urlOverride:
    "https://mobilithek.info:8443/mobilithek/api/v1.0/subscription?subscriptionID=970069105264459776",
  pollIntervalMinutes: 1440,
  reconciliationIntervalMinutes: null,
  isActive: true,
  ingestCatalog: true,
  ingestPrices: true,
  ingestStatus: false,
  credentialRef: "TESLA",
  webhookSecretRef: null,
  notes:
    "Tesla static AFIR Feed mit echter Subscription-ID aus Mobilithek. Pull-Zugriff ueber den von Mobilithek angezeigten Subscription-Endpunkt.",
};

const TESLA_DYNAMIC = {
  source: "mobilithek" as const,
  cpoId: "tesla",
  name: "Tesla Dynamic AFIR",
  mode: "push" as const,
  type: "dynamic" as const,
  subscriptionId: "967817509746913280",
  urlOverride: null,
  pollIntervalMinutes: null,
  reconciliationIntervalMinutes: 5,
  isActive: true,
  ingestCatalog: false,
  ingestPrices: true,
  ingestStatus: true,
  credentialRef: "TESLA",
  webhookSecretRef: null,
  notes:
    "Tesla dynamic AFIR Feed mit echter Subscription-ID aus Mobilithek. Webhook-Ziel ist /api/mobilithek/webhook?subscriptionId=967817509746913280 auf der produktiven Web-Domain.",
};

async function upsertTeslaFeed(
  input: typeof TESLA_STATIC | typeof TESLA_DYNAMIC,
) {
  const feeds = await listFeedConfigsDb();
  const current =
    feeds.find((feed) => feed.subscriptionId === input.subscriptionId) ??
    feeds.find((feed) => feed.name === input.name);

  if (current) {
    const updated = await updateFeedConfigDb(current.id, input);
    return { action: "updated", feed: updated };
  }

  const created = await createFeedConfigDb(input);
  return { action: "created", feed: created };
}

async function main() {
  if (!usingDatabase()) {
    throw new Error("APP_DATA_SOURCE=db and DATABASE_URL are required");
  }

  // feed_configs.cpo_id has a FK constraint — ensure the CPO row exists first
  await getPool().query(
    `insert into cpos (id, name, country_code)
     values ('tesla', 'Tesla Germany GmbH', 'DE')
     on conflict (id) do update
       set name = excluded.name,
           country_code = excluded.country_code`,
  );

  const [staticResult, dynamicResult] = await Promise.all([
    upsertTeslaFeed(TESLA_STATIC),
    upsertTeslaFeed(TESLA_DYNAMIC),
  ]);

  console.log(
    JSON.stringify(
      {
        ok: true,
        results: [
          {
            action: staticResult.action,
            id: staticResult.feed?.id ?? null,
            name: staticResult.feed?.name ?? TESLA_STATIC.name,
            subscriptionId: TESLA_STATIC.subscriptionId,
          },
          {
            action: dynamicResult.action,
            id: dynamicResult.feed?.id ?? null,
            name: dynamicResult.feed?.name ?? TESLA_DYNAMIC.name,
            subscriptionId: TESLA_DYNAMIC.subscriptionId,
          },
        ],
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
