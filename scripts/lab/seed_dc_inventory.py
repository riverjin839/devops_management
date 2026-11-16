#!/usr/bin/env python3
"""DC 인벤토리 시드 Excel 생성 — 랙 20 · 장비 400 · 케이블 1,600 (전부 가짜 값).

만든 파일을 /dc-inventory ▸ 일괄 등록에 올리거나 ``POST /api/v1/dc/import/apply`` 로 적재한다.
값은 실제 환경과 무관하다: 호스트명 ``node-a-0711`` 형식, 시리얼 ``FAKE-SN-*``, 사설 대역(10.10/10.20)과
벤치마크 대역(198.18.0.0/15), 사설 4바이트 ASN(4200001000+).

    python3 scripts/lab/seed_dc_inventory.py --out /tmp/dc-seed.xlsx            # 랙 20 (기본)
    python3 scripts/lab/seed_dc_inventory.py --out /tmp/dc-small.xlsx --racks 2

랙 하나의 구성(장비 20대 · 케이블 80개):
    U42 leaf-a · U41 leaf-b · U40 mgmt · U39 패치패널(뒷면, 반깊이) · U1~U32 서버 16대(2U)
    서버마다 eth0/eth1(private) · eth2/eth3(public) → leaf-a/b, bmc → mgmt
"""
from __future__ import annotations

import argparse
import json
import sys

# 시트·열 순서 — backend/app/services/dc_inventory/exporter.py 의 SHEETS 와 같아야 한다
# (tests/test_dc_inventory_import.py 가 어긋나면 실패시킨다).
COLUMNS: dict[str, list[str]] = {
    "racks": ["name", "site", "hall", "row", "rack_no", "position_in_row", "u_height", "power_note", "status",
              "description"],
    "device_types": ["model", "vendor", "u_height", "is_full_depth", "default_role", "interface_templates"],
    "devices": ["hostname", "role", "device_type", "rack", "position_u", "face", "status", "serial", "asset_tag",
                "cluster", "k8s_node_name", "description"],
    "interfaces": ["device", "name", "speed", "purpose", "mac", "paired_with", "parent", "enabled", "description"],
    "cables": ["label", "a_device", "a_interface", "b_device", "b_interface", "status", "cable_type", "length_m",
               "description"],
    "prefixes": ["vrf", "cidr", "rack", "purpose", "gateway", "description"],
    "ip_addresses": ["vrf", "address", "device", "interface", "role", "dns_name", "description"],
    "asns": ["number", "target_type", "rack", "cluster", "fabric_tier", "description"],
}
SERVERS_PER_RACK = 16
SERVER_PORTS = [("eth0", "25G", "private-a"), ("eth1", "25G", "private-b"), ("eth2", "25G", "public-a"),
                ("eth3", "25G", "public-b"), ("bmc", "1G", "bmc")]


def _templates(items: list[dict]) -> str:
    return json.dumps(items, ensure_ascii=False, sort_keys=True)


def build(racks: int = 20) -> dict[str, list[dict]]:
    """시트 이름 → 행(dict) 목록."""
    if not 1 <= racks <= 99:
        raise ValueError("racks 는 1~99")
    out: dict[str, list[dict]] = {name: [] for name in COLUMNS}
    out["device_types"] = [
        {"model": "Server-2U", "vendor": "FakeVendor", "u_height": 2, "is_full_depth": True,
         "default_role": "server", "interface_templates": _templates(
             [{"name": n, "speed_mbps": 25000 if s == "25G" else 1000, "purpose": p} for n, s, p in SERVER_PORTS])},
        {"model": "Leaf-48x25G", "vendor": "FakeVendor", "u_height": 1, "is_full_depth": True,
         "default_role": "leaf", "interface_templates": _templates([
             {"pattern": "Ethernet1/{n}", "start": 1, "count": 48, "speed_mbps": 25000, "purpose": "other"},
             {"pattern": "Ethernet1/{n}", "start": 49, "count": 8, "speed_mbps": 100000, "purpose": "uplink"}])},
        {"model": "Mgmt-48x1G", "vendor": "FakeVendor", "u_height": 1, "is_full_depth": True,
         "default_role": "mgmt", "interface_templates": _templates([
             {"pattern": "Gi1/0/{n}", "start": 1, "count": 48, "speed_mbps": 1000, "purpose": "other"},
             {"pattern": "Te1/1/{n}", "start": 1, "count": 4, "speed_mbps": 10000, "purpose": "uplink"}])},
        {"model": "Patch-24", "vendor": "FakeVendor", "u_height": 1, "is_full_depth": False,
         "default_role": "patch", "interface_templates": None},
    ]

    def iface(device: str, name: str, speed: str | None, purpose: str, paired: str | None = None) -> dict:
        return {"device": device, "name": name, "speed": speed, "purpose": purpose, "mac": None,
                "paired_with": paired, "parent": None, "enabled": True, "description": None}

    def device(hostname: str, role: str, dtype: str, rack: str, u: int, face: str = "front",
               serial: str | None = None) -> dict:
        return {"hostname": hostname, "role": role, "device_type": dtype, "rack": rack, "position_u": u,
                "face": face, "status": "active", "serial": serial, "asset_tag": None, "cluster": None,
                "k8s_node_name": hostname if role == "server" else None, "description": None}

    for n in range(1, racks + 1):
        no = f"{n:02d}"
        rack = f"R{no}"
        out["racks"].append({
            "name": rack, "site": "DC-LAB", "hall": "Hall-1", "row": "A" if n <= 10 else "B", "rack_no": n,
            "position_in_row": n if n <= 10 else n - 10, "u_height": 42, "power_note": "A/B 8kW",
            "status": "active", "description": None,
        })
        leaf_a, leaf_b, mgmt, patch = f"leaf-r{no}-a", f"leaf-r{no}-b", f"mgmt-a-{no}", f"pp-r{no}-01"
        out["devices"] += [
            device(leaf_a, "leaf", "Leaf-48x25G", rack, 42, serial=f"FAKE-SN-LA{no}"),
            device(leaf_b, "leaf", "Leaf-48x25G", rack, 41, serial=f"FAKE-SN-LB{no}"),
            device(mgmt, "mgmt", "Mgmt-48x1G", rack, 40, serial=f"FAKE-SN-MG{no}"),
            device(patch, "patch", "Patch-24", rack, 39, face="rear"),
        ]
        for leaf in (leaf_a, leaf_b):
            out["interfaces"] += [iface(leaf, f"Ethernet1/{p}", "25G", "other") for p in range(1, 49)]
            out["interfaces"] += [iface(leaf, f"Ethernet1/{p}", "100G", "uplink") for p in range(49, 57)]
        out["interfaces"] += [iface(mgmt, f"Gi1/0/{p}", "1G", "other") for p in range(1, 49)]
        out["interfaces"] += [iface(mgmt, f"Te1/1/{p}", "10G", "uplink") for p in range(1, 5)]
        for p in range(1, 25):
            out["interfaces"].append(iface(patch, f"P{p:02d}-front", None, "patch", paired=f"P{p:02d}-rear"))
            out["interfaces"].append(iface(patch, f"P{p:02d}-rear", None, "patch", paired=f"P{p:02d}-front"))

        for i in range(1, SERVERS_PER_RACK + 1):
            host = f"node-a-{no}{i:02d}"
            out["devices"].append(device(host, "server", "Server-2U", rack, 2 * i - 1, serial=f"FAKE-SN-{no}{i:02d}"))
            out["interfaces"] += [iface(host, name, speed, purpose) for name, speed, purpose in SERVER_PORTS]
            tag = f"{rack}-{no}{i:02d}"
            for label, a_if, b_dev, b_if, ctype, length in (
                (f"{tag}-PA", "eth0", leaf_a, f"Ethernet1/{i}", "dac", 2.0),
                (f"{tag}-PB", "eth1", leaf_b, f"Ethernet1/{i}", "dac", 2.0),
                (f"{tag}-UA", "eth2", leaf_a, f"Ethernet1/{16 + i}", "dac", 2.0),
                (f"{tag}-UB", "eth3", leaf_b, f"Ethernet1/{16 + i}", "dac", 2.0),
                (f"{tag}-BM", "bmc", mgmt, f"Gi1/0/{i}", "utp", 3.0),
            ):
                out["cables"].append({
                    "label": label, "a_device": host, "a_interface": a_if, "b_device": b_dev, "b_interface": b_if,
                    "status": "connected", "cable_type": ctype, "length_m": length, "description": None,
                })
            for vrf, addr, ifname in (("PRIVATE", f"10.10.{n}.{10 + i}", "eth0"),
                                      ("PRIVATE", f"10.10.{n}.{74 + i}", "eth1"),
                                      ("PRIVATE", f"10.20.{n}.{10 + i}", "bmc")):
                out["ip_addresses"].append({"vrf": vrf, "address": addr, "device": host, "interface": ifname,
                                            "role": "primary", "dns_name": None, "description": None})
        out["prefixes"] += [
            {"vrf": "PRIVATE", "cidr": f"10.10.{n}.0/26", "rack": rack, "purpose": "private-a",
             "gateway": f"10.10.{n}.1", "description": None},
            {"vrf": "PRIVATE", "cidr": f"10.10.{n}.64/26", "rack": rack, "purpose": "private-b",
             "gateway": f"10.10.{n}.65", "description": None},
            {"vrf": "PRIVATE", "cidr": f"10.20.{n}.0/26", "rack": rack, "purpose": "bmc",
             "gateway": f"10.20.{n}.1", "description": None},
            {"vrf": "PUBLIC", "cidr": f"198.18.{n}.0/27", "rack": rack, "purpose": "public-a",
             "gateway": f"198.18.{n}.1", "description": None},
        ]
        out["asns"].append({"number": 4200001000 + n, "target_type": "rack", "rack": rack, "cluster": None,
                            "fabric_tier": None, "description": "leaf"})
    return out


def to_xlsx_bytes(rows: dict[str, list[dict]]) -> bytes:
    import io

    from openpyxl import Workbook

    wb = Workbook()
    wb.remove(wb.active)
    for sheet, columns in COLUMNS.items():
        ws = wb.create_sheet(sheet)
        ws.append(columns)
        for row in rows.get(sheet, []):
            ws.append([row.get(c) for c in columns])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, help="만들 .xlsx 경로")
    ap.add_argument("--racks", type=int, default=20, help="랙 수 (기본 20 → 장비 400 · 케이블 1,600)")
    args = ap.parse_args()
    rows = build(args.racks)
    with open(args.out, "wb") as f:
        f.write(to_xlsx_bytes(rows))
    print(f"{args.out}: " + " · ".join(f"{name} {len(items):,}" for name, items in rows.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
