select
    id as customer_id,
    first_name,
    last_name,
    nullif(trim(email), '') as email,
    country,
    cast(signed_up_at as date) as signed_up_on
from {{ source('shop', 'customers') }}
