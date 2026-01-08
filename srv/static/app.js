// Global state
let map;
let currentLocation = null;
let currentLocationMarker = null;
let routeMarkers = [];
let routeLine = null;
let currentRoute = null;

const categoryIcons = {
    start: '📍',
    drive: '🛣️',
    restaurant: '🍽️',
    rest: '☕',
    end: '🏁'
};

const categoryLabels = {
    start: '出発地',
    drive: 'ドライブスポット',
    restaurant: '食事',
    rest: '休憩',
    end: '帰着'
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    initMap();
    getCurrentLocation();
    setupEventListeners();
    setDefaultTimes();
});

function initMap() {
    map = L.map('map').setView([35.6762, 139.6503], 10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
}

function setDefaultTimes() {
    // Set departure to next hour
    const now = new Date();
    now.setHours(now.getHours() + 1, 0, 0, 0);
    const hours = String(now.getHours()).padStart(2, '0');
    document.getElementById('departure-time').value = `${hours}:00`;
    updateTimeHint();
}

function getCurrentLocation() {
    const statusEl = document.getElementById('location-status');
    statusEl.textContent = '位置情報を取得中...';
    statusEl.className = 'status';

    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                setLocation(position.coords.latitude, position.coords.longitude, 'GPS');
            },
            (error) => {
                console.error('Geolocation error:', error);
                getLocationByIP();
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
        );
    } else {
        getLocationByIP();
    }
}

async function getLocationByIP() {
    const statusEl = document.getElementById('location-status');
    statusEl.textContent = 'IPアドレスから位置を推定中...';

    try {
        const response = await fetch('https://ipapi.co/json/');
        if (response.ok) {
            const data = await response.json();
            if (data.latitude && data.longitude) {
                setLocation(data.latitude, data.longitude, 'IP推定');
                return;
            }
        }
        throw new Error('IP geolocation failed');
    } catch (error) {
        console.error('IP geolocation error:', error);
        statusEl.textContent = '位置情報を取得できませんでした';
        statusEl.className = 'status error';
    }
}

function setLocation(lat, lng, source) {
    currentLocation = { lat, lng };
    
    const statusEl = document.getElementById('location-status');
    statusEl.textContent = `位置を取得しました (${source})`;
    statusEl.className = 'status success';
    
    const displayEl = document.getElementById('location-display');
    displayEl.style.display = 'block';
    document.getElementById('location-text').textContent = 
        `緯度: ${lat.toFixed(4)}, 経度: ${lng.toFixed(4)}`;
    
    // Enable generate button
    document.getElementById('generate-route-btn').disabled = false;
    
    // Update map
    map.setView([lat, lng], 11);
    
    if (currentLocationMarker) {
        currentLocationMarker.setLatLng([lat, lng]);
    } else {
        const icon = L.divIcon({
            className: 'custom-marker',
            html: '<div class="current-location-marker"></div>',
            iconSize: [20, 20],
            iconAnchor: [10, 10]
        });
        currentLocationMarker = L.marker([lat, lng], { icon })
            .addTo(map)
            .bindPopup('<strong>現在地</strong>');
    }
}

function setupEventListeners() {
    document.getElementById('get-location-btn').addEventListener('click', getCurrentLocation);
    document.getElementById('generate-route-btn').addEventListener('click', generateRoute);
    document.getElementById('regenerate-btn')?.addEventListener('click', generateRoute);
    
    // Time inputs
    document.getElementById('departure-time').addEventListener('change', updateTimeHint);
    document.getElementById('return-time').addEventListener('change', updateTimeHint);
    document.getElementById('clear-return-time').addEventListener('click', () => {
        document.getElementById('return-time').value = '';
        updateTimeHint();
    });
}

function updateTimeHint() {
    const departure = document.getElementById('departure-time').value;
    const returnTime = document.getElementById('return-time').value;
    const hintEl = document.getElementById('time-hint');
    
    if (!departure) {
        hintEl.textContent = '出発時刻を設定してください';
        return;
    }
    
    if (returnTime) {
        const [dH, dM] = departure.split(':').map(Number);
        const [rH, rM] = returnTime.split(':').map(Number);
        const dMin = dH * 60 + dM;
        const rMin = rH * 60 + rM;
        const diff = rMin - dMin;
        
        if (diff <= 0) {
            hintEl.textContent = '⚠️ 帰宅時刻は出発時刻より後にしてください';
            hintEl.className = 'time-hint error';
        } else {
            const hours = Math.floor(diff / 60);
            const mins = diff % 60;
            hintEl.textContent = `🕐 ${hours}時間${mins > 0 ? mins + '分' : ''}のドライブコースを作成します`;
            hintEl.className = 'time-hint';
        }
    } else {
        hintEl.textContent = `🕐 ${departure}に出発、帰宅時刻は自由`;
        hintEl.className = 'time-hint';
    }
}

async function generateRoute() {
    if (!currentLocation) {
        showNotification('まず位置情報を取得してください', true);
        return;
    }
    
    const departure = document.getElementById('departure-time').value;
    if (!departure) {
        showNotification('出発時刻を設定してください', true);
        return;
    }
    
    const btn = document.getElementById('generate-route-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> AIがルートを作成中...';
    
    const returnTime = document.getElementById('return-time').value;
    const includeRestaurant = document.getElementById('include-restaurant').checked;
    const includeRest = document.getElementById('include-rest').checked;
    const avoidUrban = document.getElementById('avoid-urban').checked;
    
    try {
        const response = await fetch('/api/route', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                lat: currentLocation.lat,
                lng: currentLocation.lng,
                departure_time: departure,
                return_time: returnTime || null,
                include_restaurant: includeRestaurant,
                include_rest: includeRest,
                avoid_urban: avoidUrban
            })
        });
        
        if (!response.ok) throw new Error('API error');
        
        const data = await response.json();
        currentRoute = data;
        
        // Show AI message
        const messageEl = document.getElementById('ai-message');
        if (data.message) {
            messageEl.innerHTML = `🤖 AI: ${escapeHtml(data.message)}`;
            messageEl.style.display = 'block';
        } else {
            messageEl.style.display = 'none';
        }
        
        renderRoute();
        renderRouteOnMap();
        
    } catch (error) {
        console.error('Route generation error:', error);
        showNotification('ルートの作成に失敗しました', true);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '🗺️ ドライブルートを作成';
    }
}

function renderRoute() {
    const section = document.getElementById('route-section');
    const summaryEl = document.getElementById('route-summary');
    const timelineEl = document.getElementById('route-timeline');
    
    if (!currentRoute || !currentRoute.stops || currentRoute.stops.length === 0) {
        section.style.display = 'none';
        return;
    }
    
    section.style.display = 'block';
    
    // Summary
    summaryEl.innerHTML = `
        <div class="summary-item">
            <span class="label">出発</span>
            <span class="value">${currentRoute.departure_time || '--:--'}</span>
        </div>
        <div class="summary-item">
            <span class="label">帰着予定</span>
            <span class="value">${currentRoute.estimated_return || '--:--'}</span>
        </div>
        <div class="summary-item">
            <span class="label">総距離</span>
            <span class="value">${currentRoute.total_distance_km.toFixed(1)} km</span>
        </div>
        <div class="summary-item">
            <span class="label">経由地</span>
            <span class="value">${currentRoute.stops.length - 2}箇所</span>
        </div>
    `;
    
    // Timeline
    timelineEl.innerHTML = currentRoute.stops.map((stop, index) => {
        const isFirst = index === 0;
        const isLast = index === currentRoute.stops.length - 1;
        const icon = isFirst ? categoryIcons.start : (isLast ? categoryIcons.end : categoryIcons[stop.category]);
        const label = isFirst ? '出発' : (isLast ? '帰着' : categoryLabels[stop.category]);
        
        return `
            <div class="timeline-item ${stop.category}">
                <div class="timeline-icon">${icon}</div>
                <div class="timeline-content">
                    <div class="timeline-header">
                        <span class="timeline-time">${stop.arrival_time || ''}</span>
                        <span class="timeline-label">${label}</span>
                        ${stop.distance_from_prev ? `<span class="timeline-distance">${stop.distance_from_prev.toFixed(1)}km</span>` : ''}
                    </div>
                    <div class="timeline-name">${escapeHtml(stop.name)}</div>
                    ${stop.description ? `<div class="timeline-desc">${escapeHtml(stop.description)}</div>` : ''}
                    ${stop.stay_duration ? `<div class="timeline-stay">滞在: ${stop.stay_duration}分</div>` : ''}
                </div>
            </div>
        `;
    }).join('<div class="timeline-connector"></div>');
    
    // Update Google Maps link
    updateGoogleMapsLink();
}

function updateGoogleMapsLink() {
    if (!currentRoute || !currentRoute.stops || currentRoute.stops.length < 2) return;
    
    const stops = currentRoute.stops;
    const origin = `${stops[0].lat},${stops[0].lng}`;
    const destination = `${stops[stops.length - 1].lat},${stops[stops.length - 1].lng}`;
    
    // Waypoints (excluding first and last)
    const waypoints = stops.slice(1, -1).map(stop => `${stop.lat},${stop.lng}`).join('|');
    
    let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=driving`;
    if (waypoints) {
        url += `&waypoints=${encodeURIComponent(waypoints)}`;
    }
    
    document.getElementById('google-maps-link').href = url;
}

function renderRouteOnMap() {
    // Clear existing route
    routeMarkers.forEach(marker => map.removeLayer(marker));
    routeMarkers = [];
    if (routeLine) {
        map.removeLayer(routeLine);
        routeLine = null;
    }
    
    if (!currentRoute || !currentRoute.stops || currentRoute.stops.length === 0) return;
    
    const stops = currentRoute.stops;
    const latlngs = [];
    
    stops.forEach((stop, index) => {
        const isFirst = index === 0;
        const isLast = index === stops.length - 1;
        const icon = isFirst ? categoryIcons.start : (isLast ? categoryIcons.end : categoryIcons[stop.category]);
        const label = isFirst ? '出発地' : (isLast ? '帰着地' : categoryLabels[stop.category]);
        
        const markerIcon = L.divIcon({
            className: 'custom-marker',
            html: `<span class="marker-icon marker-${index}">${icon}</span>`,
            iconSize: [36, 36],
            iconAnchor: [18, 18]
        });
        
        const marker = L.marker([stop.lat, stop.lng], { icon: markerIcon })
            .addTo(map)
            .bindPopup(`
                <strong>${stop.arrival_time || ''} ${escapeHtml(stop.name)}</strong><br>
                ${icon} ${label}
                ${stop.distance_from_prev ? `<br>前の地点から ${stop.distance_from_prev.toFixed(1)}km` : ''}
            `);
        
        routeMarkers.push(marker);
        latlngs.push([stop.lat, stop.lng]);
    });
    
    // Draw route line
    if (latlngs.length >= 2) {
        routeLine = L.polyline(latlngs, {
            color: '#4CAF50',
            weight: 4,
            opacity: 0.8,
            dashArray: '10, 10'
        }).addTo(map);
    }
    
    // Fit bounds
    if (latlngs.length > 0) {
        const bounds = L.latLngBounds(latlngs);
        map.fitBounds(bounds, { padding: [50, 50] });
    }
}

function formatTime(minutes) {
    if (minutes < 60) return `${Math.round(minutes)}分`;
    const hours = Math.floor(minutes / 60);
    const mins = Math.round(minutes % 60);
    return mins > 0 ? `${hours}時間${mins}分` : `${hours}時間`;
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showNotification(message, isError = false) {
    const notification = document.createElement('div');
    notification.className = `notification ${isError ? 'error' : 'success'}`;
    notification.textContent = message;
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.style.animation = 'slideUp 0.3s ease reverse';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}
