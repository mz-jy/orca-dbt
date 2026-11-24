select
    id as payment_id,
    order_id,
    payment_method,
    cast(amount_cents as decimal(12, 2)) / 100 as amount
from {{ source('shop', 'payments') }}
