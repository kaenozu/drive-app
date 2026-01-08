// Global state
let map;
let currentLocation = null;
let currentLocationMarker = null;
let spotMarkers = [];
let pickingLocation = false;
let spots = [];
let activeFilter = 'all';
let isSearching = false;

// Category icons
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

// Initialize the app
document.addEventListener('DOMContentLoaded', () => {
    initMap();
    getCurrentLocation();
    loadSpots();
    setupEventListeners();
});

// Initialize Leaflet map
function initMap() {
    // Default to Tokyo
    map = L.map('map').setView([35.6762, 139.6503], 10);
    
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    // Click handler for picking location
    map.on('click', (e) => {
        if (pickingLocation) {
            document.getElementById('spot-lat').value = e.latlng.lat.toFixed(6);
            document.getElementById('spot-lng').value = e.latlng.lng.toFixed(6);
            pickingLocation = false;
            map.getContainer().style.cursor = '';
            showNotification('位置を選択しました');
        }
    });
}

// Get current location
function getCurrentLocation() {
    const locationEl = document.getElementById('current-location');
    
    if (!navigator.geolocation) {
        locationEl.innerHTML = '位置情報はサポートされていません<br><small>下の入力欄から手動設定できます</small>';
        return;
    }

    locationEl.textContent = '位置情報を取得中...';

    navigator.geolocation.getCurrentPosition(
        (position) => {
            setCurrentLocation(position.coords.latitude, position.coords.longitude);
        },
        (error) => {
            console.error('Geolocation error:', error);
            let message = '位置情報を取得できませんでした';
            if (error.code === 1) {
                message = '位置情報の許可が必要です';
            } else if (error.code === 2) {
                message = '位置情報が利用できません';
            } else if (error.code === 3) {
                message = '位置情報の取得がタイムアウトしました';
            }
            locationEl.innerHTML = `${message}<br><small>下の入力欄から手動設定できます</small>`;
        },
        {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 60000
        }
    );
}

// Set current location (from geolocation or manual input)
function setCurrentLocation(lat, lng) {
    currentLocation = { lat, lng };
    
    const locationEl = document.getElementById('current-location');
    locationEl.textContent = `緯度: ${lat.toFixed(4)}, 経度: ${lng.toFixed(4)}`;
    
    // Update manual input fields
    document.getElementById('manual-lat').value = lat.toFixed(6);
    document.getElementById('manual-lng').value = lng.toFixed(6);
    
    // Update map view
    map.setView([lat, lng], 12);
    
    // Add or update current location marker
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

// Set location manually
function setLocationManually() {
    const lat = parseFloat(document.getElementById('manual-lat').value);
    const lng = parseFloat(document.getElementById('manual-lng').value);
    
    if (isNaN(lat) || isNaN(lng)) {
        showNotification('有効な緯度・経度を入力してください', true);
        return;
    }
    
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        showNotification('緯度は-90〜90、経度は-180〜180の範囲で入力してください', true);
        return;
    }
    
    setCurrentLocation(lat, lng);
    showNotification('位置を設定しました');
}

// Search nearby spots using Overpass API
async function searchNearbySpots() {
    if (!currentLocation) {
        showNotification('まず位置を設定してください', true);
        return;
    }
    
    if (isSearching) {
        showNotification('検索中です...', true);
        return;
    }
    
    isSearching = true;
    const btn = document.getElementById('search-spots-btn');
    btn.disabled = true;
    btn.textContent = '🔍 検索中...';
    
    const radius = parseInt(document.getElementById('search-radius').value) || 10000;
    const { lat, lng } = currentLocation;
    
    try {
        // Overpass API query for various POIs
        const query = `
            [out:json][timeout:25];
            (
                // Scenic viewpoints and tourist attractions
                node["tourism"="viewpoint"](around:${radius},${lat},${lng});
                node["tourism"="attraction"](around:${radius},${lat},${lng});
                way["tourism"="attraction"](around:${radius},${lat},${lng});
                
                // Restaurants
                node["amenity"="restaurant"](around:${radius},${lat},${lng});
                node["amenity"="cafe"](around:${radius},${lat},${lng});
                
                // Rest areas and parking
                node["highway"="rest_area"](around:${radius},${lat},${lng});
                node["highway"="services"](around:${radius},${lat},${lng});
                node["amenity"="parking"]["name"](around:${radius},${lat},${lng});
                
                // Hot springs (onsen)
                node["amenity"="public_bath"](around:${radius},${lat},${lng});
                node["leisure"="hot_spring"](around:${radius},${lat},${lng});
            );
            out body;
            >;
            out skel qt;
        `;
        
        const response = await fetch('https://overpass-api.de/api/interpreter', {
            method: 'POST',
            body: query
        });
        
        if (!response.ok) {
            throw new Error('Overpass API error');
        }
        
        const data = await response.json();
        
        // Process and save spots
        let addedCount = 0;
        for (const element of data.elements) {
            if (!element.tags || !element.tags.name) continue;
            if (!element.lat || !element.lon) continue;
            
            const category = categorizeOSMElement(element);
            const description = buildDescription(element);
            
            const spotData = {
                name: element.tags.name,
                category: category,
                description: description,
                latitude: element.lat,
                longitude: element.lon,
                address: element.tags['addr:full'] || element.tags['addr:street'] || '',
                rating: 0
            };
            
            try {
                const saveResponse = await fetch('/api/spots', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(spotData)
                });
                
                if (saveResponse.ok) {
                    addedCount++;
                }
            } catch (e) {
                console.error('Error saving spot:', e);
            }
        }
        
        showNotification(`${addedCount}件のスポットを追加しました`);
        loadSpots();
        
    } catch (error) {
        console.error('Error searching spots:', error);
        showNotification('スポットの検索に失敗しました', true);
    } finally {
        isSearching = false;
        btn.disabled = false;
        btn.textContent = '🔍 周辺スポットを自動収集';
    }
}

// Categorize OSM element
function categorizeOSMElement(element) {
    const tags = element.tags;
    
    if (tags.tourism === 'viewpoint' || tags.tourism === 'attraction') {
        return 'drive';
    }
    if (tags.amenity === 'restaurant' || tags.amenity === 'cafe') {
        return 'restaurant';
    }
    if (tags.highway === 'rest_area' || tags.highway === 'services' || 
        tags.amenity === 'parking' || tags.amenity === 'public_bath' ||
        tags.leisure === 'hot_spring') {
        return 'rest';
    }
    
    return 'drive';
}

// Build description from OSM tags
function buildDescription(element) {
    const tags = element.tags;
    const parts = [];
    
    if (tags.tourism === 'viewpoint') parts.push('展望スポット');
    if (tags.tourism === 'attraction') parts.push('観光スポット');
    if (tags.amenity === 'restaurant') parts.push('レストラン');
    if (tags.amenity === 'cafe') parts.push('カフェ');
    if (tags.highway === 'rest_area') parts.push('休憩エリア');
    if (tags.highway === 'services') parts.push('サービスエリア');
    if (tags.amenity === 'public_bath') parts.push('温泉・銭湯');
    if (tags.leisure === 'hot_spring') parts.push('温泉');
    
    if (tags.cuisine) parts.push(tags.cuisine);
    if (tags.description) parts.push(tags.description);
    if (tags.opening_hours) parts.push(`営業: ${tags.opening_hours}`);
    
    return parts.join(' / ');
}

// Load all spots
async function loadSpots() {
    try {
        const url = activeFilter === 'all' 
            ? '/api/spots' 
            : `/api/spots?category=${activeFilter}`;
        
        const response = await fetch(url);
        spots = await response.json();
        
        // Calculate distance if we have current location
        if (currentLocation) {
            spots = spots.map(spot => ({
                ...spot,
                distance: calculateDistance(
                    currentLocation.lat, currentLocation.lng,
                    spot.latitude, spot.longitude
                )
            }));
            // Sort by distance
            spots.sort((a, b) => a.distance - b.distance);
        }
        
        renderSpotsList();
        renderSpotMarkers();
    } catch (error) {
        console.error('Error loading spots:', error);
        document.getElementById('spots-container').innerHTML = 
            '<p class="loading">スポットの読み込みに失敗しました</p>';
    }
}

// Calculate distance between two points (Haversine formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

// Render spots list in sidebar
function renderSpotsList() {
    const container = document.getElementById('spots-container');
    
    const filteredSpots = activeFilter === 'all' 
        ? spots 
        : spots.filter(s => s.category === activeFilter);
    
    if (!filteredSpots || filteredSpots.length === 0) {
        container.innerHTML = '<p class="loading">スポットがありません<br><small>「周辺スポットを自動収集」で追加できます</small></p>';
        return;
    }

    container.innerHTML = filteredSpots.map(spot => `
        <div class="spot-card" data-id="${spot.id}" onclick="focusSpot(${spot.id})">
            <span class="category-badge ${spot.category}">
                ${categoryIcons[spot.category]} ${categoryLabels[spot.category]}
            </span>
            <h3>${escapeHtml(spot.name)}</h3>
            ${spot.description ? `<p>${escapeHtml(spot.description)}</p>` : ''}
            ${spot.distance !== undefined ? `<p class="distance">📍 ${spot.distance.toFixed(1)} km</p>` : ''}
            ${spot.rating > 0 ? `<p>⭐ ${spot.rating}</p>` : ''}
            <div class="spot-actions">
                <button class="btn btn-danger" onclick="event.stopPropagation(); deleteSpot(${spot.id})">
                    削除
                </button>
            </div>
        </div>
    `).join('');
}

// Render spot markers on map
function renderSpotMarkers() {
    // Clear existing markers
    spotMarkers.forEach(marker => map.removeLayer(marker));
    spotMarkers = [];

    const filteredSpots = activeFilter === 'all' 
        ? spots 
        : spots.filter(s => s.category === activeFilter);

    filteredSpots.forEach(spot => {
        const icon = L.divIcon({
            className: 'custom-marker',
            html: `<span class="marker-icon">${categoryIcons[spot.category]}</span>`,
            iconSize: [30, 30],
            iconAnchor: [15, 15]
        });

        const marker = L.marker([spot.latitude, spot.longitude], { icon })
            .addTo(map)
            .bindPopup(`
                <div class="popup-content">
                    <h3>${escapeHtml(spot.name)}</h3>
                    <p>${categoryIcons[spot.category]} ${categoryLabels[spot.category]}</p>
                    ${spot.description ? `<p>${escapeHtml(spot.description)}</p>` : ''}
                    ${spot.address ? `<p>📍 ${escapeHtml(spot.address)}</p>` : ''}
                    ${spot.rating > 0 ? `<p class="rating">⭐ ${spot.rating}</p>` : ''}
                </div>
            `);
        
        marker.spotId = spot.id;
        spotMarkers.push(marker);
    });
}

// Focus on a specific spot
function focusSpot(id) {
    const spot = spots.find(s => s.id === id);
    if (spot) {
        map.setView([spot.latitude, spot.longitude], 14);
        const marker = spotMarkers.find(m => m.spotId === id);
        if (marker) {
            marker.openPopup();
        }
    }
}

// Delete a spot
async function deleteSpot(id) {
    if (!confirm('このスポットを削除しますか？')) return;

    try {
        const response = await fetch(`/api/spots/${id}`, {
            method: 'DELETE'
        });

        if (response.ok) {
            showNotification('スポットを削除しました');
            loadSpots();
        } else {
            throw new Error('Failed to delete');
        }
    } catch (error) {
        console.error('Error deleting spot:', error);
        showNotification('削除に失敗しました', true);
    }
}

// Clear all spots
async function clearAllSpots() {
    if (!confirm('すべてのスポットを削除しますか？\nこの操作は取り消せません。')) return;
    
    try {
        const response = await fetch('/api/spots/clear', {
            method: 'DELETE'
        });
        
        if (response.ok) {
            showNotification('すべてのスポットを削除しました');
            loadSpots();
        } else {
            throw new Error('Failed to clear');
        }
    } catch (error) {
        console.error('Error clearing spots:', error);
        showNotification('削除に失敗しました', true);
    }
}

// Setup event listeners
function setupEventListeners() {
    // Refresh location button
    document.getElementById('refresh-location').addEventListener('click', getCurrentLocation);
    
    // Manual location set
    document.getElementById('set-location-btn').addEventListener('click', setLocationManually);
    
    // Search spots button
    document.getElementById('search-spots-btn').addEventListener('click', searchNearbySpots);
    
    // Clear all spots button
    document.getElementById('clear-spots-btn').addEventListener('click', clearAllSpots);

    // Filter buttons
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeFilter = btn.dataset.category;
            loadSpots();
        });
    });

    // Add spot modal
    const modal = document.getElementById('add-spot-modal');
    const addBtn = document.getElementById('add-spot-btn');
    const closeBtn = modal.querySelector('.close');

    addBtn.addEventListener('click', () => {
        modal.style.display = 'block';
    });

    closeBtn.addEventListener('click', () => {
        modal.style.display = 'none';
    });

    window.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.style.display = 'none';
        }
    });

    // Use current location button
    document.getElementById('use-current-location').addEventListener('click', () => {
        if (currentLocation) {
            document.getElementById('spot-lat').value = currentLocation.lat.toFixed(6);
            document.getElementById('spot-lng').value = currentLocation.lng.toFixed(6);
        } else {
            showNotification('現在地が取得できていません', true);
        }
    });

    // Pick on map button
    document.getElementById('pick-on-map').addEventListener('click', () => {
        pickingLocation = true;
        modal.style.display = 'none';
        map.getContainer().style.cursor = 'crosshair';
        showNotification('地図をクリックして位置を選択してください');
    });

    // Add spot form
    document.getElementById('add-spot-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const spotData = {
            name: document.getElementById('spot-name').value,
            category: document.getElementById('spot-category').value,
            description: document.getElementById('spot-description').value,
            address: document.getElementById('spot-address').value,
            latitude: parseFloat(document.getElementById('spot-lat').value),
            longitude: parseFloat(document.getElementById('spot-lng').value),
            rating: parseFloat(document.getElementById('spot-rating').value) || 0
        };

        try {
            const response = await fetch('/api/spots', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(spotData)
            });

            if (response.ok) {
                showNotification('スポットを追加しました');
                modal.style.display = 'none';
                e.target.reset();
                loadSpots();
            } else {
                throw new Error('Failed to add spot');
            }
        } catch (error) {
            console.error('Error adding spot:', error);
            showNotification('追加に失敗しました', true);
        }
    });
}

// Helper functions
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showNotification(message, isError = false) {
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: ${isError ? '#dc3545' : '#28a745'};
        color: white;
        padding: 15px 30px;
        border-radius: 8px;
        z-index: 2000;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        animation: slideUp 0.3s ease;
    `;
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => {
        notification.style.animation = 'slideDown 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

// Add CSS animation
const style = document.createElement('style');
style.textContent = `
    @keyframes slideUp {
        from { transform: translateX(-50%) translateY(100px); opacity: 0; }
        to { transform: translateX(-50%) translateY(0); opacity: 1; }
    }
    @keyframes slideDown {
        from { transform: translateX(-50%) translateY(0); opacity: 1; }
        to { transform: translateX(-50%) translateY(100px); opacity: 0; }
    }
`;
document.head.appendChild(style);
