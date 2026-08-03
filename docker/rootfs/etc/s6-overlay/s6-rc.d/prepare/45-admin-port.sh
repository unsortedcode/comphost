#!/command/with-contenv bash
# shellcheck shell=bash

# This command reads the `NPM_ADMIN_PORT` env var and will fall
# back to 81 if this is not set or is not a number.

set -e

log_info 'Admin Port ...'

NPM_ADMIN_PORT="${NPM_ADMIN_PORT:-81}"
# ensure admin port is a number
if ! [[ "$NPM_ADMIN_PORT" =~ ^[0-9]+$ ]]; then
	echo "WARNING: NPM_ADMIN_PORT must be a number. Defaulting to 81" >&2
	NPM_ADMIN_PORT=81
fi

PRODFILE="/etc/nginx/conf.d/production.conf"
SED_REGEX="s/\{\{NPM_ADMIN_PORT\}\}/${NPM_ADMIN_PORT}/g"

if is_mounted "$PRODFILE"; then
	echo "WARNING: skipping ${PRODFILE} — mounted file" >&2
elif [ -f "$PRODFILE.template" ]; then
	if sed -E "$SED_REGEX" "$PRODFILE.template" > "$PRODFILE" && [ -s "$PRODFILE" ]; then
		# success
		log_info "Generated ${PRODFILE} from template"
	else
		log_fatal "Failed to generate ${PRODFILE} from template"
	fi
fi

# Security headers for the admin interface. X_FRAME_OPTIONS is an upstream knob,
# so the CSP frame-ancestors directive is derived from it rather than hardcoded —
# otherwise the two would disagree and the stricter one would silently win.
X_FRAME_OPTIONS="${X_FRAME_OPTIONS:-DENY}"
case "$X_FRAME_OPTIONS" in
	[Dd][Ee][Nn][Yy])             CSP_FRAME_ANCESTORS="'none'" ;;
	[Ss][Aa][Mm][Ee][Oo][Rr][Ii][Gg][Ii][Nn]) CSP_FRAME_ANCESTORS="'self'" ;;
	*)                            CSP_FRAME_ANCESTORS="${X_FRAME_OPTIONS#*[Ff][Rr][Oo][Mm] }" ;;
esac

SECFILE="/etc/nginx/conf.d/include/admin-security.conf"
if is_mounted "$SECFILE"; then
	echo "WARNING: skipping ${SECFILE} — mounted file" >&2
elif [ -f "$SECFILE.template" ]; then
	if sed -e "s|{{X_FRAME_OPTIONS}}|${X_FRAME_OPTIONS}|g" 	       -e "s|{{CSP_FRAME_ANCESTORS}}|${CSP_FRAME_ANCESTORS}|g" 	       "$SECFILE.template" > "$SECFILE" && [ -s "$SECFILE" ]; then
		log_info "Generated ${SECFILE} from template"
	else
		log_fatal "Failed to generate ${SECFILE} from template"
	fi
fi
