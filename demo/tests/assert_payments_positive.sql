-- Refunds are their own rows in the till export; a negative payment is a till error.
{{ config(severity = 'warn') }}
select * from {{ ref('stg_payments') }} where amount <= 0
