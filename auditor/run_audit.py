#!/usr/bin/env python3
import os
import sys
import json
import re
import time
import argparse
from pathlib import Path
from typing import Dict, Any, List, Optional

import requests
from web3 import Web3
from tabulate import tabulate

ETHERSCAN_API = {
    "mainnet": "https://api.etherscan.io/api",
    "sepolia": "https://api-sepolia.etherscan.io/api",
    "holesky": "https://api-holesky.etherscan.io/api",
}

EIP1967_IMPLEMENTATION_SLOT = Web3.to_hex(Web3.keccak(text="eip1967.proxy.implementation")[:-1] + b"\x01")
# Known slot used by OpenZeppelin proxies: 0x360894A13BA1A3210667C828492DB98DCA3E2076CC3735A920A3CA505D382BBC
EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"

TRANSFER_TOPIC = Web3.keccak(text="Transfer(address,address,uint256)").hex()
BLACKLISTED_TOPIC = Web3.keccak(text="Blacklisted(address)").hex()
UPGR_TOPIC = Web3.keccak(text="Upgraded(address)").hex()
OWNERSHIP_TX_TOPIC = Web3.keccak(text="OwnershipTransferred(address,address)").hex()

ROLE_SETTERS = ["updateOracle", "updateBlacklister", "updatePauser", "updateMasterMinter", "updateRescuer"]


def fetch_source_from_etherscan(address: str, chain: str, api_key: str) -> Dict[str, Any]:
    url = ETHERSCAN_API[chain]
    params = {
        "module": "contract",
        "action": "getsourcecode",
        "address": address,
        "apikey": api_key,
    }
    r = requests.get(url, params=params, timeout=30)
    r.raise_for_status()
    data = r.json()
    if not data.get("result"):
        raise RuntimeError(f"No source result for {address}")
    return data["result"][0]


def expand_sources(item: Dict[str, Any], out_dir: Path) -> List[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    src = item.get("SourceCode", "")
    paths = []
    if not src:
        return paths
    # Etherscan may wrap JSON in extra braces
    def try_json(s: str):
        for cand in (s, s.strip()[1:-1] if s.strip().startswith("{{") and s.strip().endswith("}}") else None):
            if not cand:
                continue
            try:
                return json.loads(cand)
            except Exception:
                continue
        return None

    j = try_json(src)
    if isinstance(j, dict) and "sources" in j:
        for rel, meta in j["sources"].items():
            content = meta.get("content", "")
            p = out_dir / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content, encoding="utf-8")
            paths.append(p)
    else:
        name = (item.get("ContractName") or "Contract").strip() or "Contract"
        p = out_dir / f"{name}.sol"
        p.write_text(src, encoding="utf-8")
        paths.append(p)
    return paths


def detect_proxy_and_impl(w3: Web3, proxy_addr: str) -> Optional[str]:
    try:
        raw = w3.eth.get_storage_at(Web3.to_checksum_address(proxy_addr), int(EIP1967_IMPLEMENTATION_SLOT, 16))
        if raw and len(raw) == 32:
            impl = Web3.to_checksum_address(raw[-20:].hex())
            return impl
    except Exception:
        return None
    return None


def grep_patterns(text: str) -> Dict[str, List[str]]:
    findings: Dict[str, List[str]] = {
        "init_functions": [],
        "unprotected_inits": [],
        "unprotected_role_setters": [],
        "internal_transfer_calls": [],
    }
    lines = text.splitlines()
    for i, line in enumerate(lines, 1):
        if re.search(r"\bfunction\s+initialize\b", line) or "initializeV2_1" in line or "initializeV2(" in line:
            findings["init_functions"].append(f"L{i}: {line.strip()}")
            # Check if onlyOwner on same line (heuristic)
            if "onlyOwner" not in line:
                # lookahead few lines
                context = "\n".join(lines[i - 1:i + 3])
                if "onlyOwner" not in context:
                    findings["unprotected_inits"].append(f"L{i}: {line.strip()}")
        if re.search(r"\b_transfer\s*\(", line):
            findings["internal_transfer_calls"].append(f"L{i}: {line.strip()}")
        for setter in ROLE_SETTERS:
            if re.search(rf"\b{setter}\s*\(", line):
                # Check onlyOwner
                context = "\n".join(lines[i - 1:i + 3])
                if "onlyOwner" not in context:
                    findings["unprotected_role_setters"].append(f"L{i}: {line.strip()}")
    return findings


def run_slither_if_available(source_root: Path) -> Optional[str]:
    try:
        import subprocess
        cmd = ["slither", str(source_root)]
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, check=False)
        return p.stdout
    except Exception:
        return None


def scan_logs(w3: Web3, address: str, from_block: int, to_block: int, step: int = 50000) -> Dict[str, List[Dict[str, Any]]]:
    addr = Web3.to_checksum_address(address)
    all_transfers: List[Dict[str, Any]] = []
    all_blacklisted: List[Dict[str, Any]] = []
    all_upgraded: List[Dict[str, Any]] = []
    for start in range(from_block, to_block + 1, step):
        end = min(to_block, start + step - 1)
        try:
            logs = w3.eth.get_logs({"address": addr, "fromBlock": start, "toBlock": end})
        except Exception:
            continue
        for l in logs:
            t0 = l["topics"][0].hex()
            if t0 == TRANSFER_TOPIC:
                all_transfers.append({"block": l["blockNumber"], "tx": l["transactionHash"].hex(), "topics": [t.hex() for t in l["topics"]]})
            elif t0 == BLACKLISTED_TOPIC:
                all_blacklisted.append({"block": l["blockNumber"], "tx": l["transactionHash"].hex(), "topics": [t.hex() for t in l["topics"]]})
            elif t0 == UPGR_TOPIC:
                all_upgraded.append({"block": l["blockNumber"], "tx": l["transactionHash"].hex(), "topics": [t.hex() for t in l["topics"]]})
    return {"transfer": all_transfers, "blacklisted": all_blacklisted, "upgraded": all_upgraded}


def write_report(report_path: Path, meta: Dict[str, Any], findings: Dict[str, Any]) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    with report_path.open("w", encoding="utf-8") as f:
        f.write(f"# Smart Contract Audit Snapshot\n\n")
        f.write(f"- Address: `{meta.get('address')}`\n")
        f.write(f"- Chain: `{meta.get('chain')}`\n")
        if meta.get("implementation"):
            f.write(f"- Implementation: `{meta['implementation']}`\n")
        f.write("\n## Heuristic Source Findings\n\n")
        for k, arr in findings.get("grep", {}).items():
            f.write(f"- {k}: {len(arr)}\n")
            for it in arr[:10]:
                f.write(f"  - {it}\n")
        if findings.get("slither"):
            f.write("\n## Slither Summary (truncated)\n\n")
            f.write("```\n")
            f.write(findings["slither"][:5000])
            f.write("\n```\n")
        if findings.get("logs"):
            f.write("\n## On-chain Events (batched scan)\n\n")
            for kind, arr in findings["logs"].items():
                f.write(f"- {kind}: {len(arr)}\n")
                for it in arr[:10]:
                    f.write(f"  - blk {it['block']} tx {it['tx']}\n")
        f.write("\n## Notes\n- This is an automated snapshot to guide manual review per your methodology.\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--address", required=True)
    ap.add_argument("--chain", default="mainnet", choices=list(ETHERSCAN_API.keys()))
    ap.add_argument("--from-block", type=int, default=None)
    ap.add_argument("--to-block", type=int, default=None)
    ap.add_argument("--skip-slither", action="store_true")
    args = ap.parse_args()

    api_key = os.environ.get("ETHERSCAN_API_KEY")
    if not api_key:
        print("ETHERSCAN_API_KEY is required", file=sys.stderr)
        sys.exit(1)
    rpc_url = os.environ.get("RPC_URL", "https://ethereum-rpc.publicnode.com")
    w3 = Web3(Web3.HTTPProvider(rpc_url, request_kwargs={"timeout": 30}))

    address = Web3.to_checksum_address(args.address)
    latest = w3.eth.block_number
    from_block = args.from_block or max(0, latest - 200000)
    to_block = args.to_block or latest

    # Proxy detection
    impl = detect_proxy_and_impl(w3, address)

    # Fetch source for impl (fallback to address itself if no impl)
    target = impl or address
    item = fetch_source_from_etherscan(target, args.chain, api_key)
    out_root = Path("auditor/downloads") / target
    sources = expand_sources(item, out_root)

    # Grep heuristics
    concat = "\n\n".join(Path(p).read_text(encoding="utf-8", errors="ignore") for p in sources)
    grep = grep_patterns(concat)

    # Optional slither
    sl = None
    if not args.skip_slither:
        sl = run_slither_if_available(out_root)

    # Logs scan
    logs = scan_logs(w3, address, from_block, to_block, step=50000)

    report = Path("auditor/reports") / f"{address}.md"
    write_report(report, {"address": address, "chain": args.chain, "implementation": impl}, {"grep": grep, "slither": sl, "logs": logs})
    print("Report:", report)


if __name__ == "__main__":
    main()