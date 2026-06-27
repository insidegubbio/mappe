import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// types
interface POI {
    lat: number;
    lon: number;
    name?: string;
    desc?: string;
    ele?: number;
    sym?: string;
}

interface RequestBody {
    name?: string;
    description?: string;
    pois: POI[];
    create_track?: boolean;
    color?: string;
    profile?: string; // foot, bike, car
    routing?: boolean; // default true
}

interface RoutePoint {
    lon: number;
    lat: number;
    ele?: number;
}

// helpers
function escapeXml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function buildWpt(poi: POI): string {
    const name = poi.name ? `\n    <name>${escapeXml(poi.name)}</name>` : '';
    const desc = poi.desc ? `\n    <desc>${escapeXml(poi.desc)}</desc>` : '';
    const ele  = poi.ele  != null ? `\n    <ele>${poi.ele}</ele>` : '';
    const sym  = poi.sym  ? `\n    <sym>${escapeXml(poi.sym)}</sym>` : '';
    return `  <wpt lat="${poi.lat}" lon="${poi.lon}">${ele}${name}${desc}${sym}\n  </wpt>`;
}

function buildTrkptFromPoint(p: RoutePoint): string {
    const ele = p.ele != null ? `\n        <ele>${p.ele.toFixed(2)}</ele>` : '';
    return `      <trkpt lat="${p.lat}" lon="${p.lon}">${ele}\n      </trkpt>`;
}

function buildTrkptFromPOI(poi: POI): string {
    const ele = poi.ele != null ? `\n        <ele>${poi.ele}</ele>` : '';
    return `      <trkpt lat="${poi.lat}" lon="${poi.lon}">${ele}\n      </trkpt>`;
}

// graphhopper routing
async function getRouteBetween(
    from: POI,
    to: POI,
    profile: string
): Promise<RoutePoint[]> {
    const body = {
        points: [[from.lon, from.lat], [to.lon, to.lat]],
        profile,
        elevation: true,
        points_encoded: false,
        details: ['road_class', 'surface', 'hike_rating', 'mtb_rating'],
        custom_model: {}
    };

    const res = await fetch('https://graphhopper.gpx.studio/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000)
    });

    if (!res.ok) {
        throw new Error(`GraphHopper error: ${res.status}`);
    }

    const data = await res.json();
    const coordinates: [number, number, number][] = data.paths[0].points.coordinates;

    return coordinates.map(([lon, lat, ele]) => ({ lon, lat, ele }));
}

async function buildRoutedTrackPoints(pois: POI[], profile: string): Promise<RoutePoint[]> {
    const allPoints: RoutePoint[] = [];

    for (let i = 0; i < pois.length - 1; i++) {
        const segment = await getRouteBetween(pois[i], pois[i + 1], profile);
        // avoid duplicate points at segment junctions
        if (i > 0 && allPoints.length > 0) {
            allPoints.push(...segment.slice(1));
        } else {
            allPoints.push(...segment);
        }
    }

    return allPoints;
}

async function buildGPX(body: RequestBody): Promise<string> {
    const {
        name = 'Generated route',
        description = '',
        pois,
        create_track = true,
        color,
        profile = 'foot',
        routing = true
    } = body;

    const now = new Date().toISOString();

    // waypoints (<wpt>)
    const waypoints = pois.map(buildWpt).join('\n');

    // track (<trk>)
    let track = '';
    if (create_track && pois.length >= 2) {
        let trkpts: string;

        if (routing) {
            try {
                const routePoints = await buildRoutedTrackPoints(pois, profile);
                trkpts = routePoints.map(buildTrkptFromPoint).join('\n');
            } catch (e) {
                // fallback to straight lines if routing fails
                console.error('Routing failed, falling back to straight lines:', e);
                trkpts = pois.map(buildTrkptFromPOI).join('\n');
            }
        } else {
            trkpts = pois.map(buildTrkptFromPOI).join('\n');
        }

        const extensions = color
            ? `\n    <extensions>\n      <gpx_style:line>\n        <gpx_style:color>${escapeXml(color)}</gpx_style:color>\n        <gpx_style:opacity>1</gpx_style:opacity>\n        <gpx_style:width>3</gpx_style:width>\n      </gpx_style:line>\n    </extensions>`
            : '';

        track = `
  <trk>
    <name>${escapeXml(name)}</name>${extensions}
    <trkseg>
${trkpts}
    </trkseg>
  </trk>`;
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx
  version="1.1"
  creator="gpx.studio inside gubbio API"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:gpx_style="http://www.topografix.com/GPX/gpx_style/0/2"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${escapeXml(name)}</name>
    <desc>${escapeXml(description)}</desc>
    <author>
      <name>gpx.studio</name>
      <link href="https://gpx.studio"/>
    </author>
    <time>${now}</time>
  </metadata>
${waypoints}${track}
</gpx>`;
}

// validation
function validatePOI(poi: unknown, index: number): POI {
    if (typeof poi !== 'object' || poi === null) {
        throw error(400, `pois[${index}]: must be an object`);
    }
    const p = poi as Record<string, unknown>;

    const lat = Number(p.lat);
    const lon = Number(p.lon);

    if (isNaN(lat) || lat < -90  || lat > 90)  throw error(400, `pois[${index}].lat: must be a number between -90 and 90`);
    if (isNaN(lon) || lon < -180 || lon > 180) throw error(400, `pois[${index}].lon: must be a number between -180 and 180`);

    return {
        lat,
        lon,
        name: p.name != null ? String(p.name) : undefined,
        desc: p.desc != null ? String(p.desc) : undefined,
        ele:  p.ele  != null && !isNaN(Number(p.ele)) ? Number(p.ele) : undefined,
        sym:  p.sym  != null ? String(p.sym)  : undefined,
    };
}

const VALID_PROFILES = ['foot', 'bike', 'car', 'mtb', 'racingbike', 'hike'];

// handler
export const POST: RequestHandler = async ({ request }) => {
    let body: unknown;

    try {
        body = await request.json();
    } catch {
        throw error(400, 'Invalid JSON body');
    }

    if (typeof body !== 'object' || body === null) {
        throw error(400, 'Body must be a JSON object');
    }

    const b = body as Record<string, unknown>;

    if (!Array.isArray(b.pois) || b.pois.length === 0) {
        throw error(400, '`pois` must be a non-empty array');
    }
    if (b.pois.length > 500) {
        throw error(400, '`pois` can contain at most 500 points');
    }

    const profile = b.profile != null ? String(b.profile) : 'foot';
    if (!VALID_PROFILES.includes(profile)) {
        throw error(400, `\`profile\` must be one of: ${VALID_PROFILES.join(', ')}`);
    }

    const pois = b.pois.map((p, i) => validatePOI(p, i));

    const parsed: RequestBody = {
        name:         b.name         != null ? String(b.name)         : undefined,
        description:  b.description  != null ? String(b.description)  : undefined,
        create_track: b.create_track != null ? Boolean(b.create_track) : true,
        routing:      b.routing      != null ? Boolean(b.routing)      : true,
        color:        b.color        != null ? String(b.color)         : undefined,
        profile,
        pois,
    };

    const gpxContent = await buildGPX(parsed);
    const filename = (parsed.name ?? 'route').replace(/[^a-z0-9_-]/gi, '_') + '.gpx';

    return new Response(gpxContent, {
        status: 200,
        headers: {
            'Content-Type': 'application/gpx+xml',
            'Content-Disposition': `attachment; filename="${filename}"`,
        },
    });
};

export const GET: RequestHandler = async () => {
    return json({
        description: 'Generate a GPX file from a list of points of interest, with optional road routing via GraphHopper.',
        method: 'POST',
        body: {
            name: 'string (optional) — name of the GPX file and track',
            description: 'string (optional) - metadata description',
            create_track: 'boolean (optional, default true) - connect POIs as a track',
            routing: 'boolean (optional, default true) — use road routing between POIs (false = straight lines)',
            profile: `string (optional, default "foot") - routing profile: ${VALID_PROFILES.join(', ')}`,
            color: 'string (optional) — hex color for the track line, e.g. "ff0000"',
            pois: [
                {
                    lat: 'number (required) — latitude  [-90, 90]',
                    lon: 'number (required) — longitude [-180, 180]',
                    name: 'string (optional) — waypoint name',
                    desc: 'string (optional) — waypoint description',
                    ele: 'number (optional) — elevation in meters',
                    sym: 'string (optional) — GPX symbol name, e.g. "Flag, Blue"',
                },
            ],
        },
        example: {
            name: 'Giro del centro storico',
            description: 'Tour a piedi dei principali monumenti',
            create_track: true,
            routing: true,
            profile: 'foot',
            color: '0055ff',
            pois: [
                { lat: 43.1122, lon: 12.3888, name: 'Fontana Maggiore', desc: 'Piazza IV Novembre', ele: 493 },
                { lat: 43.1105, lon: 12.3910, name: 'Palazzo dei Priori', ele: 490 },
                { lat: 43.1135, lon: 12.3875, name: 'Arco Etrusco', ele: 500 },
            ],
        },
    });
};
