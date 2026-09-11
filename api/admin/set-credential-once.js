curl -X POST https://messagerie-influence-sav.vercel.app/api/admin/set-credential-once \
  -H "Content-Type: application/json" \
  -H "X-Setup-Secret: 66530f85ad1f90c1f56492f4440c9d26268d44b82aea33bf" \
  -d '{
    "tenant": "bbp",
    "type": "meta_instagram",
    "value": "<COLLE_ICI_LE_TOKEN_IGAAf..._QUE_TU_AS_COPIE>",
    "meta": {"ig_business_account_id": "17841404210763764"}
  }'
