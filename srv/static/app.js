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
    locationEl.textContent = '位置情報を取得中...';

    // Try browser geolocation first
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                setCurrentLocation(position.coords.latitude, position.coords.longitude);
                showNotification('位置情報を取得しました');
            },
            (error) => {
                console.error('Geolocation error:', error);
                // Fallback to IP-based geolocation
                getLocationByIP();
            },
            {
                enableHighAccuracy: true,
                timeout: 10000,
                maximumAge: 60000
            }
        );
    } else {
        // Fallback to IP-based geolocation
        getLocationByIP();
    }
}

// Fallback: Get location by IP address
async function getLocationByIP() {
    const locationEl = document.getElementById('current-location');
    locationEl.textContent = 'IPアドレスから位置を推定中...';
    
    try {
        // Try multiple IP geolocation services
        let data = null;
        
        // Try ipapi.co first (no API key needed, 1000 requests/day)
        try {
            const response = await fetch('https://ipapi.co/json/', { timeout: 5000 });
            if (response.ok) {
                data = await response.json();
                if (data.latitude && data.longitude) {
                    setCurrentLocation(data.latitude, data.longitude);
                    showNotification(`位置を推定しました (精度: 市区町村レベル)`);
                    return;
                }
            }
        } catch (e) {
            console.log('ipapi.co failed, trying alternative...');
        }
        
        // Try ip-api.com as backup (no API key, but HTTP only from browser)
        try {
            const response = await fetch('https://ipwho.is/', { timeout: 5000 });
            if (response.ok) {
                data = await response.json();
                if (data.latitude && data.longitude) {
                    setCurrentLocation(data.latitude, data.longitude);
                    showNotification(`位置を推定しました (精度: 市区町村レベル)`);
                    return;
                }
            }
        } catch (e) {
            console.log('ipwho.is failed');
        }
        
        throw new Error('All IP geolocation services failed');
        
    } catch (error) {
        console.error('IP geolocation error:', error);
        locationEl.innerHTML = '位置情報を取得できませんでした<br><small>下の入力欄から手動設定してください</small>';
    }
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
    
    const radius = parseInt(document.getElementById('search-radius').value) || 10000;
    const { lat, lng } = currentLocation;
    
    // Split queries to avoid timeout
    const queries = [
        // Query 1: Drive spots (tourism & nature)
        {
            name: '観光スポット',
            query: `[out:json][timeout:30];
                (
                    node["tourism"="viewpoint"](around:${radius},${lat},${lng});
                    node["tourism"="attraction"](around:${radius},${lat},${lng});
                    way["tourism"="attraction"](around:${radius},${lat},${lng});
                    node["tourism"="museum"](around:${radius},${lat},${lng});
                    way["tourism"="museum"](around:${radius},${lat},${lng});
                    node["tourism"="theme_park"](around:${radius},${lat},${lng});
                    way["tourism"="theme_park"](around:${radius},${lat},${lng});
                    node["tourism"="zoo"](around:${radius},${lat},${lng});
                    node["natural"="peak"]["name"](around:${radius},${lat},${lng});
                    node["natural"="waterfall"](around:${radius},${lat},${lng});
                    node["natural"="beach"](around:${radius},${lat},${lng});
                    way["natural"="beach"](around:${radius},${lat},${lng});
                    node["natural"="hot_spring"](around:${radius},${lat},${lng});
                );
                out center;`
        },
        // Query 2: Historic & religious sites
        {
            name: '寺社・史跡',
            query: `[out:json][timeout:30];
                (
                    node["historic"="castle"](around:${radius},${lat},${lng});
                    way["historic"="castle"](around:${radius},${lat},${lng});
                    node["historic"="monument"](around:${radius},${lat},${lng});
                    node["historic"="ruins"](around:${radius},${lat},${lng});
                    node["amenity"="place_of_worship"]["religion"="shinto"](around:${radius},${lat},${lng});
                    way["amenity"="place_of_worship"]["religion"="shinto"](around:${radius},${lat},${lng});
                    node["amenity"="place_of_worship"]["religion"="buddhist"](around:${radius},${lat},${lng});
                    way["amenity"="place_of_worship"]["religion"="buddhist"](around:${radius},${lat},${lng});
                );
                out center;`
        },
        // Query 3: Parks (limited)
        {
            name: '公園',
            query: `[out:json][timeout:45];
                (
                    node["leisure"="park"]["name"](around:${radius},${lat},${lng});
                );
                out center;`
        },
        // Query 4: Restaurants (name required to limit results)
        {
            name: '飲食店',
            query: `[out:json][timeout:45];
                (
                    node["amenity"="restaurant"]["name"](around:${radius},${lat},${lng});
                    node["amenity"="cafe"]["name"](around:${radius},${lat},${lng});
                    node["amenity"="fast_food"]["name"](around:${radius},${lat},${lng});
                );
                out center;`
        },
        // Query 5: Rest spots
        {
            name: '休憩スポット',
            query: `[out:json][timeout:30];
                (
                    node["highway"="rest_area"](around:${radius},${lat},${lng});
                    way["highway"="rest_area"](around:${radius},${lat},${lng});
                    node["highway"="services"](around:${radius},${lat},${lng});
                    way["highway"="services"](around:${radius},${lat},${lng});
                    node["amenity"="parking"]["name"](around:${radius},${lat},${lng});
                    node["amenity"="fuel"]["name"](around:${radius},${lat},${lng});
                    node["amenity"="public_bath"](around:${radius},${lat},${lng});
                    node["leisure"="hot_spring"](around:${radius},${lat},${lng});
                    node["shop"="convenience"]["name"](around:${radius},${lat},${lng});
                    node["tourism"="camp_site"](around:${radius},${lat},${lng});
                    way["tourism"="camp_site"](around:${radius},${lat},${lng});
                );
                out center;`
        }
    ];
    
    let totalAdded = 0;
    
    try {
        for (let i = 0; i < queries.length; i++) {
            const q = queries[i];
            btn.textContent = `🔍 ${q.name}を検索中... (${i+1}/${queries.length})`;
        
            try {
                // Try multiple Overpass API servers
                const servers = [
                    'https://overpass-api.de/api/interpreter',
                    'https://overpass.kumi.systems/api/interpreter',
                    'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
                ];
                
                let response = null;
                for (const server of servers) {
                    try {
                        response = await fetch(server, {
                            method: 'POST',
                            body: q.query
                        });
                        if (response.ok) break;
                    } catch (e) {
                        console.log(`Server ${server} failed, trying next...`);
                    }
                }
                
                if (!response) {
                    console.error(`All servers failed for ${q.name}`);
                    continue;
                }
                
                if (!response.ok) {
                    console.error(`Query ${q.name} failed:`, response.status);
                    continue;
                }
                
                const data = await response.json();
                
                // Process and save spots
                for (const element of data.elements) {
                    if (!element.tags || !element.tags.name) continue;
                    
                    // Get coordinates (node has lat/lon, way/relation has center)
                    let elLat = element.lat;
                    let elLon = element.lon;
                    if (!elLat && element.center) {
                        elLat = element.center.lat;
                        elLon = element.center.lon;
                    }
                    if (!elLat || !elLon) continue;
                    
                    const category = categorizeOSMElement(element);
                    const description = buildDescription(element);
                    
                    const spotData = {
                        name: element.tags.name,
                        category: category,
                        description: description,
                        latitude: elLat,
                        longitude: elLon,
                        address: element.tags['addr:full'] || element.tags['addr:street'] || element.tags['addr:city'] || '',
                        rating: 0
                    };
                    
                    try {
                        const saveResponse = await fetch('/api/spots', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(spotData)
                        });
                        
                        if (saveResponse.ok) {
                            totalAdded++;
                        }
                    } catch (e) {
                        // Ignore individual save errors
                    }
                }
            } catch (e) {
                console.error(`Query ${q.name} error:`, e);
            }
            
            // Small delay between queries to be nice to the API
            await new Promise(r => setTimeout(r, 500));
        }
        
        showNotification(`${totalAdded}件のスポットを追加しました`);
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
    
    // Restaurant category
    if (tags.amenity === 'restaurant' || tags.amenity === 'cafe' ||
        tags.amenity === 'fast_food' || tags.amenity === 'food_court' ||
        tags.amenity === 'ice_cream' || tags.amenity === 'pub' ||
        tags.amenity === 'bar' || tags.shop === 'bakery') {
        return 'restaurant';
    }
    
    // Rest category
    if (tags.highway === 'rest_area' || tags.highway === 'services' ||
        tags.amenity === 'parking' || tags.amenity === 'public_bath' ||
        tags.leisure === 'hot_spring' || tags.natural === 'hot_spring' ||
        tags.amenity === 'fuel' || tags.shop === 'convenience' ||
        tags.amenity === 'toilets' || tags.amenity === 'marketplace' ||
        tags.tourism === 'camp_site' || tags.tourism === 'caravan_site' ||
        tags.tourism === 'picnic_site' || tags.leisure === 'picnic_table' ||
        tags.shop === 'massage') {
        return 'rest';
    }
    
    // Everything else is a drive spot (tourism, nature, historic, etc.)
    return 'drive';
}

// Build description from OSM tags
function buildDescription(element) {
    const tags = element.tags;
    const parts = [];
    
    // Type descriptions
    const typeMap = {
        'tourism=viewpoint': '展望スポット',
        'tourism=attraction': '観光スポット',
        'tourism=museum': '博物館・美術館',
        'tourism=gallery': 'ギャラリー',
        'tourism=theme_park': 'テーマパーク',
        'tourism=zoo': '動物園',
        'tourism=camp_site': 'キャンプ場',
        'tourism=caravan_site': 'オートキャンプ場',
        'tourism=picnic_site': 'ピクニックサイト',
        'amenity=restaurant': 'レストラン',
        'amenity=cafe': 'カフェ',
        'amenity=fast_food': 'ファストフード',
        'amenity=pub': 'パブ',
        'amenity=bar': 'バー',
        'amenity=ice_cream': 'アイスクリーム',
        'amenity=public_bath': '温泉・銭湯',
        'amenity=fuel': 'ガソリンスタンド',
        'amenity=parking': '駐車場',
        'amenity=marketplace': '道の駅・物産店',
        'amenity=place_of_worship': '寺社仏閣',
        'highway=rest_area': '休憩エリア',
        'highway=services': 'SA・サービスエリア',
        'highway=viewpoint': '展望スポット',
        'leisure=hot_spring': '温泉',
        'leisure=park': '公園',
        'leisure=nature_reserve': '自然保護区',
        'leisure=water_park': 'ウォーターパーク',
        'natural=peak': '山頂',
        'natural=volcano': '火山',
        'natural=waterfall': '滝',
        'natural=hot_spring': '温泉',
        'natural=beach': 'ビーチ',
        'natural=cave_entrance': '洞窟',
        'historic=castle': '城',
        'historic=monument': '記念碑',
        'historic=ruins': '遺跡',
        'historic=memorial': '記念碑',
        'shop=bakery': 'パン屋',
        'shop=convenience': 'コンビニ',
    };
    
    // Find matching type
    for (const [key, label] of Object.entries(typeMap)) {
        const [k, v] = key.split('=');
        if (tags[k] === v) {
            parts.push(label);
            break;
        }
    }
    
    // Additional info
    if (tags.cuisine) {
        const cuisineMap = {
            'japanese': '和食', 'sushi': '寿司', 'ramen': 'ラーメン',
            'italian': 'イタリアン', 'chinese': '中華', 'french': 'フレンチ',
            'korean': '韓国料理', 'indian': 'インド料理', 'thai': 'タイ料理',
            'burger': 'ハンバーガー', 'pizza': 'ピザ', 'seafood': '海鮮',
            'noodle': '麺類', 'curry': 'カレー', 'coffee': 'コーヒー'
        };
        const cuisine = tags.cuisine.split(';')[0];
        parts.push(cuisineMap[cuisine] || cuisine);
    }
    
    if (tags.religion) {
        const religionMap = { 'shinto': '神社', 'buddhist': '寺院', 'christian': '教会' };
        parts.push(religionMap[tags.religion] || '');
    }
    
    if (tags.ele) parts.push(`標高${tags.ele}m`);
    if (tags.opening_hours) parts.push(`営業: ${tags.opening_hours}`);
    if (tags.phone) parts.push(`℡${tags.phone}`);
    if (tags.website) parts.push('🌐 Webあり');
    if (tags.description) parts.push(tags.description);
    
    return parts.filter(p => p).join(' / ');
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
