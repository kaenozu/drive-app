// Global state
let map;
let currentLocation = null;
let currentLocationMarker = null;
let spotMarkers = [];
let currentRecommendations = [];
let selectedRating = 0;
let feedbackSpotId = null;

const categoryIcons = {
    drive: '🛣️',
    restaurant: '🍽️',
    rest: '☕'
};

const categoryLabels = {
    drive: 'ドライブ',
    restaurant: '食事',
    rest: '休憩'
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
    
    // Enable recommend button
    document.getElementById('recommend-btn').disabled = false;
    
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
    document.getElementById('recommend-btn').addEventListener('click', getRecommendations);
    
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

async function getRecommendations() {
    if (!currentLocation) {
        showNotification('まず位置情報を取得してください', true);
        return;
    }
    
    const btn = document.getElementById('recommend-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> AIが考え中...';
    
    const maxDistance = parseFloat(document.getElementById('max-distance').value);
    const maxTime = parseFloat(document.getElementById('max-time').value);
    const category = document.getElementById('category-filter').value;
    
    try {
        const response = await fetch('/api/recommend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                lat: currentLocation.lat,
                lng: currentLocation.lng,
                max_distance_km: maxDistance,
                max_time_hours: maxTime,
                category: category
            })
        });
        
        if (!response.ok) throw new Error('API error');
        
        const data = await response.json();
        currentRecommendations = data.spots || [];
        
        // Show AI message
        const messageEl = document.getElementById('ai-message');
        if (data.message) {
            messageEl.textContent = data.message;
            messageEl.style.display = 'block';
        } else {
            messageEl.style.display = 'none';
        }
        
        // Show user stats
        const statsEl = document.getElementById('user-stats');
        if (data.user_stats && data.user_stats.total_visits > 0) {
            statsEl.innerHTML = `📊 あなたの訪問履歴: ${data.user_stats.total_visits}箇所` +
                (data.user_stats.favorite_category ? 
                    ` | お気に入り: ${categoryLabels[data.user_stats.favorite_category] || data.user_stats.favorite_category}` : '');
            statsEl.style.display = 'block';
        } else {
            statsEl.style.display = 'none';
        }
        
        renderRecommendations();
        renderSpotMarkers();
        
    } catch (error) {
        console.error('Recommendation error:', error);
        showNotification('おすすめの取得に失敗しました', true);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '🤖 AIにおすすめを聞く';
    }
}

function renderRecommendations() {
    const section = document.getElementById('recommendations');
    const container = document.getElementById('spots-container');
    
    if (currentRecommendations.length === 0) {
        section.style.display = 'none';
        return;
    }
    
    section.style.display = 'block';
    container.innerHTML = currentRecommendations.map(spot => `
        <div class="spot-card" data-id="${spot.id}">
            <span class="category ${spot.category}">
                ${categoryIcons[spot.category]} ${categoryLabels[spot.category]}
            </span>
            <h3>${escapeHtml(spot.name)}</h3>
            ${spot.description ? `<p class="description">${escapeHtml(spot.description)}</p>` : ''}
            <div class="distance-info">
                <span>📝 片道 ${spot.distance_km}km</span>
                <span>⏱️ 片道約 ${formatTime(spot.driving_time_min)}</span>
                <span>🔄 往復 ${spot.round_trip_km}km / ${formatTime(spot.round_trip_min)}</span>
            </div>
            <div class="actions">
                <button class="btn btn-primary" onclick="acceptSpot(${spot.id}); openInMaps(${spot.latitude}, ${spot.longitude}); event.stopPropagation();">
                    📍 ここに行く
                </button>
                <button class="btn btn-secondary" onclick="openFeedbackModal(${spot.id}, '${escapeHtml(spot.name).replace(/'/g, "\\'")}')"; event.stopPropagation();">
                    ⭐ 評価する
                </button>
            </div>
        </div>
    `).join('');
    
    // Click to focus on map
    container.querySelectorAll('.spot-card').forEach(card => {
        card.addEventListener('click', () => {
            const id = parseInt(card.dataset.id);
            focusSpot(id);
        });
    });
}

function formatTime(minutes) {
    if (minutes < 60) return `${minutes}分`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}時間${mins}分` : `${hours}時間`;
}

function renderSpotMarkers() {
    // Clear existing markers
    spotMarkers.forEach(marker => map.removeLayer(marker));
    spotMarkers = [];
    
    currentRecommendations.forEach(spot => {
        const icon = L.divIcon({
            className: 'custom-marker',
            html: `<span class="marker-icon">${categoryIcons[spot.category]}</span>`,
            iconSize: [30, 30],
            iconAnchor: [15, 15]
        });
        
        const marker = L.marker([spot.latitude, spot.longitude], { icon })
            .addTo(map)
            .bindPopup(`
                <strong>${escapeHtml(spot.name)}</strong><br>
                ${categoryIcons[spot.category]} ${categoryLabels[spot.category]}<br>
                📝 ${spot.distance_km}km / ${formatTime(spot.driving_time_min)}
            `);
        
        marker.spotId = spot.id;
        spotMarkers.push(marker);
    });
    
    // Fit bounds if we have spots
    if (currentRecommendations.length > 0 && currentLocation) {
        const bounds = L.latLngBounds([[currentLocation.lat, currentLocation.lng]]);
        currentRecommendations.forEach(spot => {
            bounds.extend([spot.latitude, spot.longitude]);
        });
        map.fitBounds(bounds, { padding: [50, 50] });
    }
}

function focusSpot(id) {
    const spot = currentRecommendations.find(s => s.id === id);
    if (spot) {
        map.setView([spot.latitude, spot.longitude], 13);
        const marker = spotMarkers.find(m => m.spotId === id);
        if (marker) marker.openPopup();
    }
}

async function acceptSpot(spotId) {
    try {
        await fetch('/api/accept', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ spot_id: spotId })
        });
    } catch (error) {
        console.error('Accept error:', error);
    }
}

function openInMaps(lat, lng) {
    const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
    window.open(url, '_blank');
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
