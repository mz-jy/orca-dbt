select
    customers.customer_id,
    customers.first_name,
    customers.last_name,
    customers.email,
    customers.country,
    min(orders.ordered_at) as first_order_at,
    max(orders.ordered_at) as last_order_at,
    count(orders.order_id) as orders,
    coalesce(sum(orders.amount), 0) as lifetime_value
from {{ ref('stg_customers') }} as customers
left join {{ ref('fct_orders') }} as orders using (customer_id)
group by all
