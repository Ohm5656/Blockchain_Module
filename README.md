# Blockchain Module

โมดูลสำหรับเตรียม เซ็น และส่งธุรกรรม USDC ผ่าน Avalanche Fuji Testnet

## Workflow

```text
Backend
  ↓
Blockchain Module
  ├─ เตรียม transaction
  ├─ sign ด้วย service wallet
  ├─ ส่งไป Avalanche Fuji RPC
  ├─ ได้ tx hash
  ├─ รอ receipt
  └─ verify ว่า USDC ถูกส่งจริง
```
