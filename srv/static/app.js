// Global state
let map;
let currentLocation = null;
let currentLocationMarker = null;
let routeMarkers = [];
let routeLine = null;
let currentRoute = null;
let selectedRating = 0;
let feedbackSpotId = null;

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
    loadHistory();
});

function initMap() {
    map = L.map('map').setView([35.6762, 139.6503], 10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
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
    
    // Rating stars
    document.querySelectorAll('#rating-stars span').forEach(star => {
        star.addEventListener('click', () => {
            selectedRating = parseInt(star.dataset.rating);
            updateStars();
        });
    });
    
    document.getElementById('submit-feedback').addEventListener('click', submitFeedback);
    document.getElementById('cancel-feedback').addEventListener('click', closeFeedbackModal);
}

async function generateRoute() {
    if (!currentLocation) {
        showNotification('まず位置情報を取得してください', true);
        return;
    }
    
    const btn = document.getElementById('generate-route-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> AIがルートを作成中...';
    
    const maxDistance = parseFloat(document.getElementById('max-distance').value);
    const maxTime = parseFloat(document.getElementById('max-time').value);
    const includeRestaurant = document.getElementById('include-restaurant').checked;
    const includeRest = document.getElementById('include-rest').checked;
    
    try {
        const response = await fetch('/api/route', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                lat: currentLocation.lat,
                lng: currentLocation.lng,
                max_distance_km: maxDistance,
                max_time_hours: maxTime,
                include_restaurant: includeRestaurant,
                include_rest: includeRest
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
            <span class="label">総距離</span>
            <span class="value">${currentRoute.total_distance_km.toFixed(1)} km</span>
        </div>
        <div class="summary-item">
            <span class="label">総時間</span>
            <span class="value">${formatTime(currentRoute.total_time_min)}</span>
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
                        <span class="timeline-label">${label}</span>
                        ${stop.distance_from_prev ? `<span class="timeline-distance">${stop.distance_from_prev.toFixed(1)}km</span>` : ''}
                    </div>
                    <div class="timeline-name">${escapeHtml(stop.name)}</div>
                    ${stop.description ? `<div class="timeline-desc">${escapeHtml(stop.description)}</div>` : ''}
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
                <strong>${index + 1}. ${escapeHtml(stop.name)}</strong><br>
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

function openFeedbackModal(spotId, spotName) {
    feedbackSpotId = spotId;
    selectedRating = 0;
    updateStars();
    document.getElementById('feedback-spot-name').textContent = spotName;
    document.getElementById('feedback-comment').value = '';
    document.getElementById('feedback-modal').style.display = 'flex';
}

function closeFeedbackModal() {
    document.getElementById('feedback-modal').style.display = 'none';
    feedbackSpotId = null;
}

function updateStars() {
    document.querySelectorAll('#rating-stars span').forEach(star => {
        const rating = parseInt(star.dataset.rating);
        star.classList.toggle('active', rating <= selectedRating);
    });
}

async function submitFeedback() {
    if (!feedbackSpotId || selectedRating === 0) {
        showNotification('評価を選択してください', true);
        return;
    }
    
    const comment = document.getElementById('feedback-comment').value;
    
    try {
        const response = await fetch('/api/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                spot_id: feedbackSpotId,
                rating: selectedRating,
                comment: comment
            })
        });
        
        if (!response.ok) throw new Error('API error');
        
        showNotification('評価を送信しました！');
        closeFeedbackModal();
        loadHistory();
        
    } catch (error) {
        console.error('Feedback error:', error);
        showNotification('送信に失敗しました', true);
    }
}

async function loadHistory() {
    try {
        const response = await fetch('/api/history?limit=10');
        if (!response.ok) throw new Error('API error');
        
        const history = await response.json();
        
        const section = document.getElementById('history-section');
        const container = document.getElementById('history-container');
        
        if (!history || history.length === 0) {
            section.style.display = 'none';
            return;
        }
        
        section.style.display = 'block';
        container.innerHTML = history.map(item => `
            <div class="history-item">
                <span class="history-name">
                    ${categoryIcons[item.spot_category] || ''} ${escapeHtml(item.spot_name)}
                </span>
                <span class="history-rating">
                    ${item.rating ? '⭐'.repeat(item.rating) : '未評価'}
                </span>
            </div>
        `).join('');
        
    } catch (error) {
        console.error('History error:', error);
    }
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
