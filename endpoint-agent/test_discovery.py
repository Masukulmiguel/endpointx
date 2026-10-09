"""Unit tests for the EndpointX agent LAN discovery module.

Stdlib unittest only. All parser/validation tests feed captured text or
mocked psutil data so the suite never touches the network.
"""

import ipaddress
import json
import socket
import unittest
from collections import namedtuple
from unittest import mock

import discovery

# Stand-in for psutil's snicaddr namedtuple (family, address, netmask, ...).
_FakeAddr = namedtuple(
    "_FakeAddr", ["family", "address", "netmask", "broadcast", "ptp"]
)
_FakeAddr.__new__.__defaults__ = (None, None)


def _addr(ip, netmask):
    return _FakeAddr(socket.AF_INET, ip, netmask)


class TestParseArpOutput(unittest.TestCase):
    def test_parse_proc_net_arp(self):
        fixture = (
            "IP address       HW type     Flags       HW address            Mask   Device\n"
            "192.168.1.1      0x1         0x2         aa:bb:cc:dd:ee:ff     *      eth0\n"
            "192.168.1.20     0x1         0x2         AA:BB:CC:DD:EE:FF     *      eth0\n"
            "192.168.1.50     0x1         0x0         00:00:00:00:00:00     *      eth0\n"
        )
        parsed = discovery.parse_arp_output(fixture, "proc")
        self.assertEqual(
            parsed,
            {
                "192.168.1.1": "aa:bb:cc:dd:ee:ff",
                "192.168.1.20": "aa:bb:cc:dd:ee:ff",
                "192.168.1.50": None,
            },
        )

    def test_parse_arp_a_windows(self):
        fixture = (
            "Interface: 192.168.1.100 --- 0x5\n"
            "  Internet Address      Physical Address      Type\n"
            "  192.168.1.1           00-11-22-33-44-55     dynamic\n"
            "  192.168.1.20          aa-bb-cc-dd-ee-ff     dynamic\n"
            "  192.168.1.99          (incomplete)          invalid\n"
        )
        parsed = discovery.parse_arp_output(fixture, "windows")
        self.assertEqual(
            parsed,
            {
                "192.168.1.1": "00:11:22:33:44:55",
                "192.168.1.20": "aa:bb:cc:dd:ee:ff",
            },
        )


class TestGetLocalSubnets(unittest.TestCase):
    def test_get_local_subnets_rfc1918_only_and_slash22_cap(self):
        fake_addrs = {
            "eth0": [_addr("10.0.0.5", "255.0.0.0")],
            "eth1": [_addr("192.168.1.10", "255.255.255.0")],
            "eth2": [_addr("8.8.8.8", "255.255.255.255")],
            "lo": [_addr("127.0.0.1", "255.0.0.0")],
        }
        with mock.patch("psutil.net_if_addrs", return_value=fake_addrs):
            subnets = discovery.get_local_subnets()

        self.assertLessEqual(len(subnets), 4)
        self.assertEqual(len(subnets), 2)

        by_iface = {s["interface"]: s for s in subnets}
        self.assertNotIn("eth2", by_iface)
        self.assertNotIn("lo", by_iface)

        eth0 = by_iface["eth0"]
        self.assertEqual(eth0["cidr"], "10.0.0.0/8")
        self.assertEqual(eth0["prefixlen"], 8)
        self.assertEqual(eth0["network"], ipaddress.IPv4Address("10.0.0.0"))

        # prefixlen >= 23 clamped to 22
        eth1 = by_iface["eth1"]
        self.assertEqual(eth1["prefixlen"], 22)
        self.assertEqual(eth1["cidr"], "192.168.0.0/22")
        self.assertEqual(eth1["network"], ipaddress.IPv4Address("192.168.0.0"))

        for subnet in subnets:
            self.assertLessEqual(subnet["prefixlen"], 22)


class TestValidateRequestedCidr(unittest.TestCase):
    def test_validate_requested_cidr_rejects_public_and_foreign(self):
        local = [
            {
                "interface": "eth1",
                "cidr": "192.168.1.0/24",
                "network": ipaddress.IPv4Address("192.168.1.0"),
                "prefixlen": 24,
            }
        ]

        self.assertIsNotNone(discovery.validate_requested_cidr("8.8.8.0/24", local))
        self.assertIsNotNone(
            discovery.validate_requested_cidr("192.168.5.0/24", local)
        )
        self.assertIsNotNone(
            discovery.validate_requested_cidr("192.168.1.0/23", local)
        )
        self.assertIsNone(discovery.validate_requested_cidr("192.168.1.0/24", local))
        self.assertIsNone(discovery.validate_requested_cidr("", local))


class TestOsEstimate(unittest.TestCase):
    def test_os_estimate_never_invents(self):
        self.assertEqual(discovery.os_estimate("DESKTOP-ABC1"), "Windows")
        self.assertEqual(discovery.os_estimate("Android-123"), "Android")
        self.assertEqual(discovery.os_estimate("printer-01"), "Unknown")
        self.assertEqual(discovery.os_estimate(None), "Unknown")
        self.assertEqual(discovery.os_estimate("WIN-XYZ9"), "Windows")
        self.assertEqual(discovery.os_estimate("office-mbp-7"), "macOS")


class TestScan(unittest.TestCase):
    def test_scan_report_schema(self):
        fake_addrs = {"eth0": [_addr("10.9.9.9", "255.255.255.0")]}
        neighbors = {
            "10.9.9.1": "aa:bb:cc:dd:ee:ff",
            "10.9.9.50": None,
            "10.9.9.9": "11:22:33:44:55:66",
        }
        live = {"10.9.9.50", "10.9.9.66"}

        with mock.patch("psutil.net_if_addrs", return_value=fake_addrs), mock.patch.object(
            discovery, "read_neighbors", return_value=neighbors
        ), mock.patch.object(
            discovery, "ping_sweep", return_value=(live, False)
        ) as sweep_mock, mock.patch.object(
            discovery, "reverse_dns", return_value="printer-01"
        ):
            report = discovery.scan()
            expected_cidrs = [s["cidr"] for s in discovery.get_local_subnets()]

        self.assertEqual(set(report), {"subnets", "truncated", "hosts"})
        self.assertIsInstance(report["subnets"], list)
        self.assertEqual(report["subnets"], expected_cidrs)
        self.assertFalse(report["truncated"])

        sweep_mock.assert_called_once()
        self.assertEqual(sweep_mock.call_args[0][0], expected_cidrs)

        ips = [h["ip"] for h in report["hosts"]]
        self.assertEqual(set(ips), {"10.9.9.1", "10.9.9.50", "10.9.9.66"})
        self.assertNotIn("10.9.9.9", ips)

        for host in report["hosts"]:
            self.assertEqual(
                set(host), {"ip", "mac", "hostname", "os_estimate", "rtt_ms"}
            )
            self.assertNotIn("vendor", host)
            self.assertIsNone(host["rtt_ms"])

        by_ip = {h["ip"]: h for h in report["hosts"]}
        self.assertEqual(by_ip["10.9.9.1"]["mac"], "aa:bb:cc:dd:ee:ff")
        self.assertIsNone(by_ip["10.9.9.50"]["mac"])
        self.assertIsNone(by_ip["10.9.9.66"]["mac"])
        self.assertEqual(by_ip["10.9.9.1"]["hostname"], "printer-01")
        self.assertEqual(by_ip["10.9.9.1"]["os_estimate"], "Unknown")

        json.dumps(report)


if __name__ == "__main__":
    unittest.main()
