Auditor Toolkit

Usage

- Prereqs: Python 3.10+, solc-select, Slither optional, Mythril optional
- Install deps:
  - python3 -m venv venv && . venv/bin/activate
  - pip install -r auditor/requirements.txt
- Env:
  - export ETHERSCAN_API_KEY=YOUR_KEY
  - export RPC_URL=https://ethereum-rpc.publicnode.com
- Run:
  - python auditor/run_audit.py --address 0x... --chain mainnet

What it does

- Fetches verified source via Etherscan, expands multi-file JSON
- Detects proxies and reads implementation slot (EIP-1967)
- Runs heuristic checks for init functions, onlyOwner, role setters, _transfer usage
- Optionally runs Slither if installed, and collates key findings
- Queries on-chain logs (Transfer/Blacklisted, Upgraded) in batched ranges
- Outputs a markdown summary under auditor/reports/<address>.md