#!/usr/bin/env python3
"""Problem Exchange — pay the EXISTING /api/verify verdict engine for
a DONE grade and print its report as JSON (last stdout line).

The grade path is the real rail, mirroring flow-agent/explain.py:
POST /api/verify with the house agent's enrolled identity (enrolled
price $0.005; standard $0.02 — decision #5 fixes Flow's DONE take at
the verify fee), answer the 402 challenge with an EIP-3009 USDC
authorization signed by the operational wallet (flow-agent/x402_pay.py,
which enforces the payTo pin and the $2/day self-spend cap + ledger),
and return the engine's report including its settlement tx.

If the payment cannot be made (e.g. the ops wallet holds no USDC and
the facilitator rejects the authorization), this prints
{"ok": false, ...} with the gate's own answer and exits non-zero —
no grade is invented. The operator records the attempt on the
listing instead (see exchange-operate.js `note`).

Usage: exchange-verify.py --contract 0x... [--chain base]
"""
import argparse
import json
import os
import sys
import urllib.request
import urllib.error

sys.path.insert(0, "/home/hatch/workspace/flow-agent")
import x402_pay  # noqa: E402

VERIFY_URL = "https://flow-kg4x.vercel.app/api/verify"
KEY_PATH = os.path.expanduser("~/.config/flowexecutor_wallet_key")


def _account():
    from eth_account import Account
    with open(KEY_PATH) as f:
        return Account.from_key(f.read().strip())


def _enrolled_fields(acct, address, chain):
    """agent + agentSig for /api/verify's enrolled price.

    Canonical message (api/_enrolled.js enrolledVerifyMessage):
    "flow:data:<agent>:/api/verify:address=<address>[&chain=<chain>]"
    — agent and address lowercased, params sorted (address, chain),
    chain included only when the body carries one.
    """
    from eth_account.messages import encode_defunct
    params = {"address": address.lower()}
    if chain:
        params["chain"] = chain.lower()
    tail = "&".join(f"{k}={params[k]}" for k in sorted(params))
    msg = f"flow:data:{acct.address.lower()}:/api/verify:{tail}"
    signed = acct.sign_message(encode_defunct(text=msg))
    return {"agent": acct.address, "agentSig": "0x" + signed.signature.hex()}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--contract", required=True)
    ap.add_argument("--chain", default="base")
    args = ap.parse_args()

    acct = _account()
    payload = {"address": args.contract, "chain": args.chain}
    payload.update(_enrolled_fields(acct, args.contract, args.chain))
    data = json.dumps(payload).encode()

    def post(extra_headers=None):
        req = urllib.request.Request(
            VERIFY_URL, data=data, method="POST",
            headers={"Content-Type": "application/json", **(extra_headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.status, resp.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()

    status, text = post()
    if status == 402:
        try:
            body = json.loads(text)
        except Exception:
            print(json.dumps({"ok": False, "stage": "challenge-parse", "status": status, "detail": text[:500]}))
            return 1
        accepts = (body.get("accepts") or [None])[0]
        try:
            header, price = x402_pay.build_payment_header(
                accepts, VERIFY_URL,
                extensions=body.get("extensions"), resource=body.get("resource"))
        except Exception as e:
            print(json.dumps({"ok": False, "stage": "sign", "detail": str(e)}))
            return 1
        status, text = post({"X-PAYMENT": header})
        if status == 200:
            x402_pay.record_spend(price, VERIFY_URL)
    if status != 200:
        print(json.dumps({
            "ok": False, "stage": "verify-call", "status": status, "detail": text[:800],
            "note": "No grade recorded. If the paid retry was rejected, the "
                    "facilitator's verify names the reason (the ops wallet "
                    "holding 0 USDC surfaces as invalid_payload here and as "
                    "invalid_exact_evm_insufficient_balance on a direct "
                    "facilitator probe).",
        }))
        return 1
    report = json.loads(text)
    payment = report.get("payment") or {}
    print(json.dumps({
        "ok": True,
        "report": report,
        "payment_tx": payment.get("transaction"),
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
