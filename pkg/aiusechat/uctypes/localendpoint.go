// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package uctypes

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
)

// FoundryBridgePort is the port the Crowe Logic Foundry bridge listens on. Every
// shipped CroweLM mode points at it, so a dial failure here is the single most
// likely reason a fresh install cannot answer a message.
const FoundryBridgePort = "8011"

// IsLocalEndpoint reports whether endpoint is served from this machine. A dial
// failure against one of these means "nothing is running here", which is a
// different problem from a provider outage and needs a different message.
func IsLocalEndpoint(endpoint string) bool {
	u, err := url.Parse(endpoint)
	if err != nil {
		return false
	}
	host := u.Hostname()
	// Hostnames are case-insensitive and url.Parse preserves what it was given.
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// LocalEndpointDialError rewrites a failed connection to a local model server
// into something the user can act on. It returns nil when the error is anything
// other than a dial failure against a local endpoint, so callers keep their
// original error in every case this does not understand.
func LocalEndpointDialError(endpoint string, err error) error {
	if err == nil || !IsLocalEndpoint(endpoint) || !isDialFailure(err) {
		return nil
	}
	u, parseErr := url.Parse(endpoint)
	if parseErr != nil {
		return nil
	}
	if u.Port() == FoundryBridgePort {
		return fmt.Errorf(
			"no Crowe Logic Foundry agent is answering at %s. The CroweLM models run through a Foundry bridge on this machine, and one is not running. Start the Foundry, or choose a model from a provider you have an API key for in Settings > AI",
			u.Host)
	}
	return fmt.Errorf(
		"no model server is answering at %s. This model is configured to run on this machine, and nothing is listening there. Start the server, or choose a model from a provider you have an API key for in Settings > AI",
		u.Host)
}

// isDialFailure matches any failure to establish the connection (refused,
// unreachable, timed out) rather than only ECONNREFUSED, so a bridge that is
// half up reads the same as one that is absent.
func isDialFailure(err error) bool {
	var opErr *net.OpError
	return errors.As(err, &opErr) && opErr.Op == "dial"
}
