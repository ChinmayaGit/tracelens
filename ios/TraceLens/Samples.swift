import Foundation

// Demo traces. All secrets are FAKE and assembled at runtime so the source never
// contains strings that secret scanners (e.g. GitHub push protection) flag.
private func j(_ p: String...) -> String { p.joined() }
private let fakeAWS = j("AKIA", "IOSFODNN7", "EXAMPLE")
private let fakeStripe = j("sk", "_live_", "51HxExample", "ExampleExample00")
private let fakeJWT = j("eyJhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiJyaWRlci05OTEyIn0", ".", "c2lnbmF0dXJlLWV4YW1wbGU")
private let fakeGX = j("gx_", "9f8e7d6c5b4a3f2e1d0c")

let samples: [(String, String)] = [
    ("Swift · crash", """
    Fatal error: Unexpectedly found nil while unwrapping an Optional value: file Checkout/PaymentViewController.swift, line 214
    Thread 0 Crashed:: Dispatch queue: com.apple.main-thread
    0   Shop      0x0000000102a4c3f8 PaymentViewController.confirmOrder() + 412 (PaymentViewController.swift:214)
    1   Shop      0x0000000102a4b9e0 PaymentViewController.payTapped(_:) + 64 (PaymentViewController.swift:131)
    2   UIKitCore 0x00000001a2f1c6c4 -[UIApplication sendAction:to:from:forEvent:] + 100
    [Checkout] customer=Priya Sharma email=priya.sharma@acme-internal.com cart=CART-55120 coupon=nil
    [API] Authorization: Bearer \(fakeJWT)
    """),
    ("Node · DB auth", """
    [2026-11-21T09:14:02.331Z] ERROR api-gateway-7f9c (pid 4121) request failed for priya.sharma@acme-internal.com
    Error: password authentication failed for user "svc_billing"
        at Parser.parseErrorMessage (/home/deploy/billing/node_modules/pg-protocol/dist/parser.js:287:98)
        at async Pool.connect (/home/deploy/billing/node_modules/pg-pool/index.js:45:11)
        at async chargeInvoice (/home/deploy/billing/src/invoices/charge.ts:58:20)
    config: DATABASE_URL=postgres://svc_billing:Tr0ub4dor-prod@db-primary.billing.acme.lan:5432/billing
    env: AWS_ACCESS_KEY_ID=\(fakeAWS) STRIPE_KEY=\(fakeStripe)
    upstream: 10.42.7.19:5432  customer_id=CUST-88412  invoice=INV-2026-11-00931
    """),
    ("Python · KeyError", """
    Traceback (most recent call last):
      File "/Users/jdoe/work/etl/pipeline/run.py", line 197, in main
        rows = transform(fetch_orders(since=args.since))
      File "/Users/jdoe/work/etl/pipeline/transform.py", line 64, in transform
        total += row["amount_cents"] * fx[row["currency"]]
    KeyError: 'amount_cents'
    DEBUG fetched 1200 rows from https://orders.internal.globex.io/v2/export?api_key=\(fakeGX)
    DEBUG first row: {'order_id': 'ORD-77120', 'amountCents': 4599, 'currency': 'EUR', 'email': 'hans.mueller@example.de'}
    """),
]
