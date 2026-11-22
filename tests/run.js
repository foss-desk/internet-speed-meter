// SPDX-License-Identifier: GPL-3.0-or-later
// Unit tests for the shell-independent modules. Run with `make check` (gjs -m tests/run.js).

import System from 'system';

import { fmtSize, fmtSpeed } from '../dist/format.js';
import { parseDefaultRoute, parseDefaultRoute6, parseNetDev, trafficDelta } from '../dist/network.js';
import { averageJitter } from '../dist/speedtest.js';
import { dayKey, monthKey } from '../dist/stats.js';

let failures = 0;

function equal(actual, expected, name) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        print(`ok   ${name}`);
    } else {
        failures++;
        print(`FAIL ${name}\n     expected ${e}\n     got      ${a}`);
    }
}

const NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000      10    0    0    0     0          0         0     1000      10    0    0    0     0       0          0
wlp2s0: 5000      50    0    0    0     0          0         0     2000      20    0    0    0     0       0          0
  wg0:  300       3    0    0    0     0          0         0      100       1    0    0    0     0       0          0
`;
equal(parseNetDev(NET_DEV), [
    { name: 'lo', rx: 1000, tx: 1000 },
    { name: 'wlp2s0', rx: 5000, tx: 2000 },
    { name: 'wg0', rx: 300, tx: 100 },
], 'parseNetDev reads name, rx and tx');

{
    const previous = new Map();
    equal(trafficDelta(previous, [{ name: 'a', rx: 100, tx: 50 }]), { rx: 0, tx: 0 }, 'first sample has no delta');
    equal(trafficDelta(previous, [{ name: 'a', rx: 150, tx: 60 }]), { rx: 50, tx: 10 }, 'delta between samples');
    equal(trafficDelta(previous, [{ name: 'a', rx: 160, tx: 60 }, { name: 'b', rx: 9e9, tx: 9e9 }]),
        { rx: 10, tx: 0 }, 'a new interface is not counted as traffic');
    equal(trafficDelta(previous, [{ name: 'b', rx: 9e9 + 5, tx: 9e9 }]), { rx: 5, tx: 0 },
        'a vanished interface does not hide traffic on the others');
    equal(trafficDelta(previous, [{ name: 'b', rx: 20, tx: 30 }]), { rx: 0, tx: 0 }, 'a counter reset is not negative traffic');
    equal(trafficDelta(previous, [{ name: 'a', rx: 1e12, tx: 1e12 }]), { rx: 0, tx: 0 },
        'switching the monitored interface adds no spike');
}

const ROUTE = `Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask
wlp2s0\t0002A8C0\t00000000\t0001\t0\t0\t600\t00FFFFFF
wlp2s0\t00000000\t0102A8C0\t0003\t0\t0\t600\t00000000
`;
equal(parseDefaultRoute(ROUTE), 'wlp2s0', 'parseDefaultRoute finds the default route');
equal(parseDefaultRoute(ROUTE.split('\n').slice(0, 2).join('\n')), '', 'parseDefaultRoute without a default route');

const Z = '00000000000000000000000000000000';
const ROUTE6 = `${Z} 00 ${Z} 00 ${Z} ffffffff 00000001 00000000 00200200       lo
fe800000000000000000000000000000 40 ${Z} 00 ${Z} 00000100 00000001 00000000 00000001   enp3s0
${Z} 00 ${Z} 00 fe800000000000000000000000000001 00000400 00000001 00000000 00000003   enp3s0
`;
equal(parseDefaultRoute6(ROUTE6), 'enp3s0', 'parseDefaultRoute6 skips the loopback reject route');

equal(averageJitter([10]), 0, 'jitter of one sample');
equal(averageJitter([10, 20, 10, 30]), (10 + 10 + 20) / 3, 'jitter is the mean absolute difference');

equal(dayKey(new Date(2026, 0, 5)), '2026-01-05', 'dayKey pads month and day');
equal(monthKey(new Date(2026, 11, 31)), '2026-12', 'monthKey');

equal(fmtSize(512), '512 B', 'fmtSize bytes');
equal(fmtSize(1536, 2), '1.5 KB', 'fmtSize KB');
equal(fmtSpeed(125000, true), '1.0 Mbps', 'fmtSpeed bits');

if (failures > 0) {
    print(`${failures} test(s) failed`);
    System.exit(1);
}
