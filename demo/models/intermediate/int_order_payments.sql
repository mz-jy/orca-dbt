select
    payments.order_id,
    count(*) as payments,
    sum(payments.amount) as amount,
    coalesce(bool_or(methods.is_card), false) as paid_by_card
from {{ ref('stg_payments') }} as payments
left join {{ ref('payment_methods') }} as methods using (payment_method)
group by payments.order_id
