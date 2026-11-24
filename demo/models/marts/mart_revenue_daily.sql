select
    cast(ordered_at as date) as day,
    store,
    count(*) as orders,
    sum(amount) as revenue
from {{ ref('fct_orders') }}
where status <> 'returned'
group by all
