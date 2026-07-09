import { useEffect, useRef } from "react";
import L from "leaflet";
import type { DriveLocation } from "../types/crash";

type DashboardMiniMapProps = {
  location: DriveLocation | null;
};

const DEFAULT_CENTRE: L.LatLngExpression = [-42.05, 146.6];
const MINI_MAP_ZOOM = 16;
const DRIVING_LOOKAHEAD_METRES = 140;

const getPointAhead = (
  latitude: number,
  longitude: number,
  heading?: number,
): L.LatLng => {
  if (typeof heading !== "number" || !Number.isFinite(heading)) {
    return L.latLng(latitude, longitude);
  }

  const earthRadiusMetres = 6_371_000;
  const angularDistance = DRIVING_LOOKAHEAD_METRES / earthRadiusMetres;
  const bearing = (heading * Math.PI) / 180;
  const latitudeRadians = (latitude * Math.PI) / 180;
  const longitudeRadians = (longitude * Math.PI) / 180;
  const nextLatitude = Math.asin(
    Math.sin(latitudeRadians) * Math.cos(angularDistance) +
      Math.cos(latitudeRadians) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const nextLongitude =
    longitudeRadians +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitudeRadians),
      Math.cos(angularDistance) - Math.sin(latitudeRadians) * Math.sin(nextLatitude),
    );

  return L.latLng(
    (nextLatitude * 180) / Math.PI,
    (nextLongitude * 180) / Math.PI,
  );
};

export function DashboardMiniMap({ location }: DashboardMiniMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const initialCentre: L.LatLngExpression = location
      ? [location.latitude, location.longitude]
      : DEFAULT_CENTRE;
    const map = L.map(containerRef.current, {
      attributionControl: true,
      center: initialCentre,
      zoom: location ? MINI_MAP_ZOOM : 7,
      zoomControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      touchZoom: false,
      preferCanvas: true,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      keepBuffer: 4,
      updateWhenIdle: false,
      attribution: "&copy; OpenStreetMap",
    }).addTo(map);

    const marker = L.marker(initialCentre, {
      interactive: false,
      keyboard: false,
      opacity: location ? 1 : 0,
      icon: L.divIcon({
        className: "dashboard-mini-map__vehicle",
        html: '<span aria-hidden="true"></span>',
        iconSize: [28, 34],
        iconAnchor: [14, 20],
      }),
    }).addTo(map);

    mapRef.current = map;
    markerRef.current = marker;

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const marker = markerRef.current;
    if (!map || !marker || !location) return;

    const nextPosition = L.latLng(location.latitude, location.longitude);
    marker.setLatLng(nextPosition);
    marker.setOpacity(1);
    const markerElement = marker.getElement();
    if (markerElement) {
      const heading =
        typeof location.heading === "number" && Number.isFinite(location.heading)
          ? location.heading
          : 0;
      markerElement.style.setProperty("--vehicle-heading", `${heading}deg`);
    }
    if (map.getZoom() !== MINI_MAP_ZOOM) map.setZoom(MINI_MAP_ZOOM, { animate: false });
    map.panTo(
      getPointAhead(location.latitude, location.longitude, location.heading),
      {
      animate: true,
      duration: 1.1,
      easeLinearity: 0.2,
      noMoveStart: true,
      },
    );
  }, [location?.heading, location?.latitude, location?.longitude]);

  return (
    <div
      ref={containerRef}
      className="dashboard-mini-map"
      style={{ width: "100%", height: "calc(100% + 10rem)" }}
      aria-hidden="true"
    />
  );
}
