curl -X POST https://messagerie-influence-sav.vercel.app/api/admin/set-credential-once \
  -H "Content-Type: application/json" \
  -H "X-Setup-Secret: 66530f85ad1f90c1f56492f4440c9d26268d44b82aea33bf" \
  -d '{
    "tenant": "bbp",
    "type": "meta_instagram",
    "value": "IGAAfYZA3gscW9BZAFpDNm80b1BqOEx0N09hOWhINTNCYkhOZAWtlcFFyZAkF2RjVDdjBUMHNhTGRqM2hiR0dGR29SZAGYzOVBBVGJlR09JZAE9CZA1hIZAjlleGk4OE1NRFk1MGFoVjFZAVVpzdmpqYU1Lbm53QW9JNnIxcGFrYTUtZAVd4dwZDZD",
    "meta": {"ig_business_account_id": "17841404210763764"}
  }'
