# Ahmed's Shop Customer Catalog and Policies

This file is the owner-maintained source of truth for general customer-facing
product information and business policies. The assistant reads one `##`
section at a time through `search_catalog`.

Live products, exact prices, sizes, colors, and availability come from the
SQLite product catalog through `check_stock`, not from this document. Exact
stock quantities are private. Payment destinations come only from secured
runtime configuration. Never add customer details, credentials, account
numbers, transaction references, supplier information, costs, margins, or
internal notes here.

After Ahmed changes and reviews this file, its SHA-256 must be placed in
`APPROVED_CATALOG_SHA256`. Until the exact file is approved, policy searches
fail closed instead of allowing the assistant to treat draft wording as fact.

## Store Overview

Ahmed's Shop sells clothing and footwear through WhatsApp. The general product
range includes hoodies, shirts, kurtas, trousers, jeans, T-shirts, running
shoes, sandals, and jackets. A category appearing here does not guarantee that
every size, color, design, or price is currently available.

The assistant must check the live product catalog before offering a specific
item, quoting its exact price, or saying that a requested quantity can be
fulfilled.

## Current Product Range

The general product categories are:

- Hoodies
- Shirts
- Kurtas
- Trousers
- Jeans
- T-shirts
- Running shoes
- Sandals
- Jackets

Only active records returned by the live product catalog may be described as
currently available. If no matching record is found, say that no match was
found in the current catalog. Do not claim that Ahmed never sells the item.

## Hoodies

The approved public product name is Black Hoodie. The currently recorded
variant is black in Medium size.

Its current selling price and availability must always be read from the live
product catalog. Do not place an exact stock quantity in a customer reply.

Material, fabric weight, waterproofing, season, brand, manufacturing origin,
and other attributes are not currently documented. If a customer asks about
one of these attributes, confirm it with Ahmed rather than guessing.

## Shirts

The current catalog includes Casual Shirts in S, M, L, and XL, with
navy, white, and black variants. Current recorded prices range from Rs 2,200 to
Rs 2,400.

This range is general information only. Check the live product catalog for the
current item, exact price, size, color, and availability before making an
offer or preparing an order.

## Kurtas

The current catalog includes Classic Kurtas in S, M, L, and XL, with
white, black, and navy variants. Current recorded prices range from Rs 3,200 to
Rs 3,500.

This range is general information only. Check the live product catalog for the
current item, exact price, size, color, and availability before making an
offer or preparing an order.

## Trousers

The current catalog includes Chino Trousers in S, M, L, and XL, with
beige, black, grey, and navy variants. Current recorded prices range from
Rs 2,800 to Rs 3,100.

This range is general information only. Check the live product catalog for the
current item, exact price, size, color, and availability before making an
offer or preparing an order.

## Jeans

The current catalog includes Slim Fit Jeans in waist sizes 30, 32, 34,
and 36, with blue and black variants. Current recorded prices range from
Rs 3,300 to Rs 3,600.

Check the live product catalog for the requested waist size, color, exact
price, and availability. Do not infer fabric weight, stretch, cut details, or
brand when those attributes are not recorded.

## T-Shirts

The current catalog includes Basic T-Shirts in S, M, L, and XL, with
white, black, olive, and navy variants. Current recorded prices range from
Rs 1,200 to Rs 1,350.

Check the live product catalog for the requested size, color, exact price, and
availability. Fabric composition and weight require Ahmed's confirmation when
they are not recorded.

## Shoes

The current catalog includes Running Shoes in sizes 40, 41, 42, and 43,
with black, white, navy, and grey variants. Current recorded prices range from
Rs 4,500 to Rs 4,800.

Check the live product catalog for the requested size, color, exact price, and
availability. Do not invent brand, sole material, waterproofing, or performance
claims.

## Sandals

The current catalog includes Comfort Sandals in sizes 39, 40, 41, and
42, with brown, black, and tan variants. Current recorded prices range from
Rs 2,200 to Rs 2,350.

Check the live product catalog for the requested size, color, exact price, and
availability. Material and manufacturing details require confirmation when
they are not recorded.

## Jackets

The current catalog includes Lightweight Jackets in S, M, L, and XL,
with black, navy, olive, and charcoal variants. Current recorded prices range
from Rs 5,200 to Rs 5,800.

Check the live product catalog for the requested size, color, exact price, and
availability. Warmth, lining, waterproofing, and fabric details require Ahmed's
confirmation when they are not recorded.

## Sizes and Colors

The general clothing size labels used by the shop are S (Small), M (Medium), L
(Large), and XL (Extra Large). Jeans may use waist sizes such as 30 to 36, and
footwear may use numeric sizes such as 39 to 43. Not every product is available
in every size or color.

The assistant must use the live product catalog for a requested product, size,
and color. It must not infer one variant's availability from another variant.

## Product Features

The approved structured product fields are product name, category, size,
color, public price, and availability. A customer's budget and requested
quantity may also be checked against the live catalog.

Features not recorded in those fields, such as waterproofing, exact fabric,
lining, weight, brand, or manufacturing origin, require confirmation from
Ahmed. Absence of a feature from the catalog is not proof that the product
does or does not have it.

## Product Availability

Customer-visible availability is limited to in stock, low stock, out of stock,
or whether a specifically requested quantity can be fulfilled. Exact internal
stock quantities are not customer-facing information.

Availability can change after a conversation. Stock is reserved only when the
backend successfully confirms the order; a conversational statement alone
does not reserve an item.

## Prices

The live product catalog is the authority for exact selling prices. A general
price range in this document must never override the live price of a specific
product.

The server recalculates every order from current product records. A price typed
by a customer or generated by the assistant cannot override the server price.
If the price changes before confirmation, the customer must receive and
confirm a fresh order summary.

## Discounts

No discount is guaranteed merely because a customer asks for one. The
assistant must not grant or promise a discount of 5 percent or more without
Ahmed's confirmation.

When approval is required, the assistant may create an owner handoff and must
report only the handoff state returned by the system. It must not say Ahmed
approved or viewed the request unless a verified event proves that action.

## Payment Methods

Cash on Delivery (COD) is available.

Bank transfer, Easypaisa, and JazzCash are available only when the server's
payment-options tool confirms that Ahmed has configured complete and valid
details for that method. Missing or incomplete configuration makes the method
unavailable.

Exact account names, wallet numbers, bank details, and IBANs must be sent only
by the dedicated server-controlled payment tool. The assistant must never
invent, rewrite, or send placeholder payment details.

## Payment Verification

A customer's statement or screenshot saying that payment was made is an
unverified payment claim. It does not mark an order paid and does not change
the customer's balance.

Only Ahmed's authorized review or a future trusted payment-provider result may
verify payment. Until then, the assistant must describe it as pending review.
Screenshots are evidence to review, not proof of payment.

## Ordering Process

Before preparing an order, collect the selected product and quantity,
recipient name, contact number, complete delivery address, city, payment
method, and any optional postal code or delivery landmark.

The server validates the product, current price, requested quantity, payment
method, and delivery details. It then creates a summary for the customer. This
summary is a draft and does not book or reserve the order.

The customer must explicitly confirm the complete summary in a later message.
Only a successful backend confirmation creates the order and reserves stock.
The assistant must report the actual backend result.

## Order Changes and Cancellation

A customer may request cancellation before the order has shipped. The backend
checks the current order state before accepting the cancellation.

An order that has already shipped or been delivered cannot be cancelled
through the normal cancellation path. The customer may instead ask about the
return or refund process when applicable.

Changes to product, quantity, price, delivery information, or payment method
may require a new validated order summary and a new explicit confirmation.

## Order Status and Tracking

Order status must come from the database and must be tied to the WhatsApp
identity that owns the order. A name, phone number, delivery contact, or order
number by itself is not authorization to view another customer's information.

Customer-facing order references begin with `ORD-`. The assistant may report
the real stored state, such as placed, confirmed, paid, shipped, delivered, or
cancelled. If no courier tracking record exists, it must not invent a courier,
tracking number, route, location, or delivery event.

## Delivery

Delivery is available across Pakistan.

Standard delivery is free, and the usual estimate is 3 to 5 business days
after order confirmation. The separate delivery sections below provide the
approved details and limitations.

If a destination, remote area, or special delivery condition is not covered by
this policy, confirm it with Ahmed before promising service.

## Delivery Charges

Standard delivery is free across Pakistan under the currently documented
policy.

The assistant must not invent surcharges, same-day fees, remote-area charges,
or another delivery fee. Any exceptional charge requires Ahmed's confirmation
before it is promised to a customer.

## Delivery Time

Orders are normally processed Monday to Friday during business hours. Delivery
usually takes 3 to 5 business days after order confirmation, depending on the
customer's location.

This is an estimate, not a guaranteed arrival date. The assistant must not
promise a specific dispatch or delivery date unless it is supported by a real
order or courier event.

## Return Policy

A customer may request a return within 7 days of delivery.

To be eligible, the product must be unused and unworn, in its original
condition, with its original tags and packaging attached. Products that have
been worn, washed, damaged after delivery, or altered are not eligible under
the standard policy.

The return request is still subject to review. If a situation is not clearly
covered here, create an owner handoff rather than inventing an exception or
promising acceptance.

## Exchange Policy

Eligible products may be exchanged, including for a different size, within 7
days of delivery under the same condition requirements as returns: unused,
unworn, original condition, and original tags and packaging attached.

The requested replacement must be checked in the live product catalog before
availability is promised. An exchange for a different product also requires
Ahmed's approval. If the requested replacement is not currently found, do not
promise that it will become available.

## Refund Requests

A refund request may be opened only for an order belonging to the current
WhatsApp customer and only after delivery. A delivery event within the
documented 7-day window is eligible for review. A legacy delivered order
without a reliable delivery timestamp requires manual review.

Creating a refund case does not approve or execute a refund. The customer
receives a public reference beginning with `RFD-` and may read the real case
status. Ahmed may approve or reject the request, but approval is recorded as
pending external execution until money is actually returned through an
authorized process.

The assistant must never claim that a refund was processed, sent, credited, or
completed merely because a request was recorded or approved.

## Customer Privacy and Order Access

Order and refund information is available only to the WhatsApp identity that
owns the record. The assistant must not disclose another customer's address,
phone number, order history, payment evidence, balance, or case status.

Customer-facing replies should minimize personal information. Contact numbers
should be masked when displayed back during order preparation, while complete
delivery information remains only in the authoritative fulfilment record.

## Human Support

When the assistant cannot safely resolve a question, it may create a support
handoff for Ahmed through the backend. It must describe only the confirmed
system state: recorded, pending delivery, or delivered to Ahmed's WhatsApp.

A delivered alert does not prove that Ahmed viewed it, approved it, verified
it, replied to it, or will contact the customer at a particular time. During a
payment, refund, complaint, cancellation, or tracking conversation, resolve
the support issue without adding an unrelated sales pitch.

## Unsupported Questions

If this catalog and the controlled tools do not provide an answer, the
assistant must not guess. It should explain that the information needs Ahmed's
confirmation, create the appropriate handoff when necessary, and report the
real handoff state.
