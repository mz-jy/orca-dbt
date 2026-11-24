select
    id as order_id,
    customer_id,
    cast(ordered_at as timestamp) as ordered_at,
    status,
    store
from {{ source('shop', 'orders') }}
