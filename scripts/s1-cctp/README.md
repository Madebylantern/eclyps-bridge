# S1 — CCTP V2 carries the batch root (ADR 0002)

| Step | What it proves | Needs |
| --- | --- | --- |
| `forge test` in `contracts/portal` | Receiver logic, rejection paths, parser offsets vs a real Iris message | nothing |
| `SEPOLIA_RPC_URL=… forge test` | Real Sepolia CCTP V2 mints to the receiver; a tampered hook fails the attestation; a Solana-produced message lands and its root decodes | public RPC only |
| `tsx s1-cctp/burn-with-hook.ts --simulate [--write-fixture]` | Real devnet CCTP V2 programs accept our instruction and put the 51-byte hook at offset 376 of the burn message | public RPC only |
| Live run (below) | Circle's Iris attests our message and Sepolia receives it | funded devnet + Sepolia test keys (**ask the owner first**) |

Run TS scripts from `scripts/` with `NODE_USE_ENV_PROXY=1 pnpm exec tsx …` (Node's fetch only
uses the proxy with that flag).

## Live run (devnet → Sepolia, testnet funds only)

1. Devnet keypair (outside the repo): `solana-keygen new -o ~/.config/solana/eclyps-devnet.json`.
   Fund it with devnet SOL (`solana airdrop 1 --url devnet` or faucet.solana.com) and ≥ 1 devnet
   USDC from https://faucet.circle.com (browser + reCAPTCHA, 20 USDC per request).
2. Sepolia throwaway key with a little Sepolia ETH.
3. Deploy the receiver, binding it to the devnet wallet as the only allowed sender:
   ```
   GATEWAY_SENDER=$(cd scripts && pnpm -s exec tsx s1-cctp/pubkey-hex.ts \
     $(solana-keygen pubkey ~/.config/solana/eclyps-devnet.json))
   cd contracts/portal && GATEWAY_SENDER=$GATEWAY_SENDER forge script script/DeployBatchReceiver.s.sol \
     --rpc-url $SEPOLIA_RPC_URL --private-key $SEPOLIA_PRIVATE_KEY --broadcast
   ```
4. `SOLANA_KEYPAIR=… RECEIVER=0x… tsx s1-cctp/burn-with-hook.ts --send` → prints the signature.
5. `SEPOLIA_PRIVATE_KEY=… RECEIVER=0x… tsx s1-cctp/relay.ts <signature>` → waits for Iris
   (standard finality, ~25 s on Solana plus Iris latency), relays, and checks
   `decoded root == root sent`.

Cost: 1 devnet USDC (burned, minted as Sepolia test USDC), ~0.005 devnet SOL (MessageSent rent,
reclaimable after 5 days), and Sepolia gas.
