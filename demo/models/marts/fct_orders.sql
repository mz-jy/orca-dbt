select
    orders.order_id,
    orders.customer_id,
    orders.ordered_at,
    orders.status,
    orders.store,
    coalesce(paid.amount, 0) as amount,
    coalesce(paid.paid_by_card, false) as paid_by_card
from {{ ref('stg_orders') }} as orders
left join {{ ref('int_order_payments') }} as paid using (order_id)
