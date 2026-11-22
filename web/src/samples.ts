// Demo traces. All secrets below are FAKE. They are assembled from pieces at
// runtime so the source never contains a string that secret scanners
// (e.g. GitHub push protection) mistake for a real credential.
const j = (...parts: string[]) => parts.join("");
const FAKE_AWS = j("AKIA", "IOSFODNN7", "EXAMPLE"); // AWS's documented example key
const FAKE_STRIPE = j("sk", "_live_", "51HxExample", "ExampleExample00");
const FAKE_JWT = j("eyJhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiJyaWRlci05OTEyIn0", ".", "c2lnbmF0dXJlLWV4YW1wbGU");
const FAKE_GX = j("gx_", "9f8e7d6c5b4a3f2e1d0c");

export const SAMPLES: { label: string; text: string }[] = [
  {
    label: "Node · DB auth",
    text: `[2026-11-21T09:14:02.331Z] ERROR api-gateway-7f9c (pid 4121) request failed for priya.sharma@acme-internal.com
Error: password authentication failed for user "svc_billing"
    at Parser.parseErrorMessage (/home/deploy/billing/node_modules/pg-protocol/dist/parser.js:287:98)
    at Parser.handlePacket (/home/deploy/billing/node_modules/pg-protocol/dist/parser.js:126:29)
    at Socket.<anonymous> (/home/deploy/billing/node_modules/pg-protocol/dist/index.js:11:42)
    at async Pool.connect (/home/deploy/billing/node_modules/pg-pool/index.js:45:11)
    at async chargeInvoice (/home/deploy/billing/src/invoices/charge.ts:58:20)
config: DATABASE_URL=postgres://svc_billing:Tr0ub4dor-prod@db-primary.billing.acme.lan:5432/billing
env: AWS_ACCESS_KEY_ID=${FAKE_AWS} STRIPE_KEY=${FAKE_STRIPE}
upstream: 10.42.7.19:5432  customer_id=CUST-88412  invoice=INV-2026-11-00931`,
  },
  {
    label: "Android · NPE",
    text: `FATAL EXCEPTION: main
Process: com.acme.rideshare, PID: 22817
java.lang.NullPointerException: Attempt to invoke virtual method 'java.lang.String com.acme.rideshare.model.Driver.getDisplayName()' on a null object reference
    at com.acme.rideshare.ui.trip.TripSummaryFragment.bindDriver(TripSummaryFragment.kt:142)
    at com.acme.rideshare.ui.trip.TripSummaryFragment.onViewCreated$lambda$3(TripSummaryFragment.kt:88)
    at androidx.lifecycle.LiveData.considerNotify(LiveData.java:133)
    at androidx.lifecycle.LiveData.dispatchingValue(LiveData.java:151)
    at android.os.Handler.handleCallback(Handler.java:958)
    at android.os.Looper.loop(Looper.java:294)
    at android.app.ActivityThread.main(ActivityThread.java:8177)
D/TripRepo: trip 5521-ab for rider Marcus Okafor (+1 415 555 0136) driver=null status=CANCELLED_BY_DRIVER
D/Auth: Authorization: Bearer ${FAKE_JWT}`,
  },
  {
    label: "Python · KeyError",
    text: `Traceback (most recent call last):
  File "/Users/jdoe/work/etl/pipeline/run.py", line 211, in <module>
    main()
  File "/Users/jdoe/work/etl/pipeline/run.py", line 197, in main
    rows = transform(fetch_orders(since=args.since))
  File "/Users/jdoe/work/etl/pipeline/transform.py", line 64, in transform
    total += row["amount_cents"] * fx[row["currency"]]
KeyError: 'amount_cents'
DEBUG fetched 1200 rows from https://orders.internal.globex.io/v2/export?api_key=${FAKE_GX}
DEBUG first row: {'order_id': 'ORD-77120', 'amountCents': 4599, 'currency': 'EUR', 'email': 'hans.mueller@example.de'}`,
  },
];
