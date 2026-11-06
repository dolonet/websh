#!/bin/bash
# Test helper (run as root): silently drop the packets of the connections
# CURRENTLY established to 127.0.0.1:<port> - no FIN, no RST, which is
# what a Wi-Fi switch or a sleeping laptop looks like to the peer.
# New connections are unaffected. Everything lives in its own chain and
# `off` removes it; nothing else in the firewall is touched.
#   blackhole.sh on <port>
#   blackhole.sh off
set -e
CHAIN=WEBSH_E2E
if [ "$1" = off ]; then
  iptables -D INPUT -i lo -j $CHAIN 2>/dev/null || true
  iptables -F $CHAIN 2>/dev/null || true
  iptables -X $CHAIN 2>/dev/null || true
  echo off
  exit 0
fi
[ "$1" = on ] && [ -n "$2" ] || { echo "usage: $0 on <port> | off" >&2; exit 2; }
PORT=$2
iptables -N $CHAIN 2>/dev/null || iptables -F $CHAIN
iptables -C INPUT -i lo -j $CHAIN 2>/dev/null || iptables -I INPUT -i lo -j $CHAIN
n=0
for cp in $(ss -Htn state established "( dport = :$PORT )" | awk '{split($3,a,":"); print a[length(a)]}' | sort -u); do
  iptables -A $CHAIN -p tcp --sport "$cp" --dport "$PORT" -j DROP
  iptables -A $CHAIN -p tcp --sport "$PORT" --dport "$cp" -j DROP
  n=$((n+1))
done
echo "$n"
