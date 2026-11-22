// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 MD Mojahid <aammojahid@gmail.com>

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Gio.SocketClient.prototype, 'connect_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Soup.Session.prototype, 'send_async');

export const USER_AGENT = 'internet-speed-meter (GNOME Shell extension; +https://github.com/foss-desk/internet-speed-meter)';

const decoder = new TextDecoder('utf-8');

export interface InterfaceCounters {
    name: string;
    rx: number;
    tx: number;
}

export function isCancelled(error: unknown): boolean {
    return error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

export async function readFile(path: string, cancellable: Gio.Cancellable | null): Promise<string> {
    const [contents] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
    return decoder.decode(contents);
}

export function parseNetDev(text: string): InterfaceCounters[] {
    const result: InterfaceCounters[] = [];
    // The first two lines are column headers.
    for (const line of text.split('\n').slice(2)) {
        const colon = line.indexOf(':');
        if (colon === -1)
            continue;
        const fields = line.substring(colon + 1).trim().split(/\s+/);
        result.push({
            name: line.substring(0, colon).trim(),
            rx: parseInt(fields[0], 10) || 0,
            tx: parseInt(fields[8], 10) || 0,
        });
    }
    return result;
}

// Bytes moved since the previous sample, per interface so that an interface appearing,
// disappearing or restarting its counters never shows up as traffic. Updates `previous`.
export function trafficDelta(previous: Map<string, InterfaceCounters>, current: InterfaceCounters[]): { rx: number; tx: number } {
    let rx = 0;
    let tx = 0;
    for (const counters of current) {
        const before = previous.get(counters.name);
        if (before) {
            rx += Math.max(0, counters.rx - before.rx);
            tx += Math.max(0, counters.tx - before.tx);
        }
    }
    previous.clear();
    for (const counters of current)
        previous.set(counters.name, counters);
    return { rx, tx };
}

// Hardware interfaces have a device link in sysfs; tunnels, bridges and veths do not, and
// counting them as well would count the same traffic twice. PPP is virtual but has no
// hardware counterpart in /proc/net/dev.
export function isPhysicalInterface(name: string): boolean {
    return name.startsWith('ppp') || GLib.file_test(`/sys/class/net/${name}/device`, GLib.FileTest.EXISTS);
}

// Parses /proc/net/route.
export function parseDefaultRoute(text: string): string {
    for (const line of text.split('\n').slice(1)) {
        const [iface, destination] = line.trim().split(/\s+/);
        if (destination === '00000000')
            return iface;
    }
    return '';
}

// Parses /proc/net/ipv6_route: destination, prefix length, ..., interface last.
export function parseDefaultRoute6(text: string): string {
    for (const line of text.split('\n')) {
        const fields = line.trim().split(/\s+/);
        if (fields.length === 10 && /^0+$/.test(fields[0]) && fields[1] === '00' && fields[9] !== 'lo')
            return fields[9];
    }
    return '';
}

export async function getLocalAddress(ipv6: boolean, cancellable: Gio.Cancellable | null): Promise<string> {
    const client = new Gio.SocketClient({
        family: ipv6 ? Gio.SocketFamily.IPV6 : Gio.SocketFamily.IPV4,
        type: Gio.SocketType.DATAGRAM,
        protocol: Gio.SocketProtocol.UDP,
    });
    // Connecting a UDP socket only selects the outgoing route's source address; nothing is sent.
    const target = Gio.InetSocketAddress.new_from_string(ipv6 ? '2606:4700:4700::1111' : '1.1.1.1', 53);
    const connection = await client.connect_async(target, cancellable);
    const local = connection.get_local_address() as Gio.InetSocketAddress;
    connection.close_async(GLib.PRIORITY_DEFAULT, null, null);
    return local.get_address().to_string();
}

export async function fetchText(
    session: Soup.Session,
    url: string,
    cancellable: Gio.Cancellable | null,
): Promise<string | null> {
    const message = Soup.Message.new('GET', url);
    const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
    if (message.get_status() !== Soup.Status.OK)
        return null;
    return decoder.decode(bytes.toArray());
}
