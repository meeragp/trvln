import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { periodTone, type DayStop } from "@/lib/dayRoute";

// The day's route on a map: numbered pins in visit order, coloured by period,
// joined by the teal route line. Loaded lazily from the itinerary view so
// Leaflet stays out of the main bundle and out of days with nothing to pin.
//
// Plain Leaflet rather than a React wrapper: the map is created once per
// mount and only its layers change, which is a few imperative calls.

interface Props {
  stops: DayStop[];
  activeKey: string | null;
  onSelect: (key: string) => void;
  /** Accessible name for the map region. */
  label: string;
}

const pinIcon = (stop: DayStop, active: boolean) =>
  L.divIcon({
    className: "",
    html: `<span class="trv-pin trv-pin--${periodTone(stop.periodLabel)}${active ? " trv-pin--active" : ""}">${stop.number}</span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });

export default function DayMap({ stops, activeKey, onSelect, label }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const markers = useRef(new Map<string, { marker: L.Marker; stop: DayStop }>());
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // Create the map once.
  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, {
      // A page that scrolls past the map must not get stuck zooming it.
      scrollWheelZoom: false,
      // Half steps let a compact city day fill the frame instead of snapping
      // a whole level out.
      zoomSnap: 0.5,
      zoomControl: true,
      attributionControl: true,
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(m);
    m.attributionControl.setPrefix(false);
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    // The container can be measured before layout settles (tab switch,
    // lazy mount); re-measure once it has.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => m.invalidateSize()) : null;
    ro?.observe(el.current);
    return () => {
      ro?.disconnect();
      m.remove();
      map.current = null;
      layer.current = null;
    };
  }, []);

  // Redraw pins and route whenever the stops change (another day, a replaced item).
  useEffect(() => {
    const m = map.current;
    const group = layer.current;
    if (!m || !group) return;
    group.clearLayers();
    markers.current.clear();

    const pinned = stops.filter(s => s.coords);
    if (pinned.length === 0) return;
    const points = pinned.map(s => L.latLng(s.coords!.lat, s.coords!.lng));

    if (points.length > 1) {
      L.polyline(points, { className: "trv-route", weight: 3, interactive: false }).addTo(group);
    }
    for (const stop of pinned) {
      const marker = L.marker([stop.coords!.lat, stop.coords!.lng], {
        icon: pinIcon(stop, false),
        title: `${stop.number}. ${stop.name}`,
        alt: `${stop.number}. ${stop.name}`,
        keyboard: true,
        riseOnHover: true,
      })
        .on("click", () => onSelectRef.current(stop.key))
        .addTo(group);
      markers.current.set(stop.key, { marker, stop });
    }

    if (points.length === 1) m.setView(points[0], 15);
    else m.fitBounds(L.latLngBounds(points), { padding: [28, 28], maxZoom: 17 });
  }, [stops]);

  // Highlight the selected stop and bring it into view.
  useEffect(() => {
    const m = map.current;
    for (const [key, { marker, stop }] of markers.current) {
      const active = key === activeKey;
      marker.setIcon(pinIcon(stop, active));
      marker.setZIndexOffset(active ? 1000 : 0);
      if (active && m && !m.getBounds().pad(-0.1).contains(marker.getLatLng())) {
        m.panTo(marker.getLatLng());
      }
    }
  }, [activeKey, stops]);

  return (
    <div
      ref={el}
      role="region"
      aria-label={label}
      className="trv-map h-64 sm:h-80 w-full rounded-2xl border border-border/60 overflow-hidden bg-muted/30"
    />
  );
}
