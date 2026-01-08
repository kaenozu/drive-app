// Global state
let map;
let currentLocation = null;
let currentLocationMarker = null;
let spotMarkers = [];
let pickingLocation = false;
let spots = [];
let activeFilter = 'all';

// Category icons
const categoryIcons = {
    drive: '\ud83d\udee3\ufe0f',
    restaurant: '\ud83c\udf7d\ufe0f',
    rest: '\u2615'
};

const categoryLabels = {
    drive: '\u30c9\u30e9\u30a4\u30d6',
    restaurant: '\u98df\u4e8b',
    rest: '\u4f11\u61a9'
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
            showNotification('\u4f4d\u7f6e\u3092\u9078\u629e\u3057\u307e\u3057\u305f');
        }
    });
}

// Get current location
function getCurrentLocation() {
    const locationEl = document.getElementById('current-location');
    
    if (!navigator.geolocation) {
        locationEl.textContent = '\u4f4d\u7f6e\u60c5\u5831\u306f\u30b5\u30dd\u30fc\u30c8\u3055\u308c\u3066\u3044\u307e\u305b\u3093';
        return;
    }

    locationEl.textContent = '\u4f4d\u7f6e\u60c5\u5831\u3092\u53d6\u5f97\u4e2d...';

    navigator.geolocation.getCurrentPosition(
        (position) => {
            currentLocation = {
                lat: position.coords.latitude,
                lng: position.coords.longitude
            };
            
            locationEl.textContent = `\u7def\u5ea6: ${currentLocation.lat.toFixed(4)}, \u7d4c\u5ea6: ${currentLocation.lng.toFixed(4)}`;
            
            // Update map view
            map.setView([currentLocation.lat, currentLocation.lng], 12);
            
            // Add or update current location marker
            if (currentLocationMarker) {
                currentLocationMarker.setLatLng([currentLocation.lat, currentLocation.lng]);
            } else {
                const icon = L.divIcon({
                    className: 'custom-marker',
                    html: '<div class="current-location-marker"></div>',
                    iconSize: [20, 20],
                    iconAnchor: [10, 10]
                });
                currentLocationMarker = L.marker([currentLocation.lat, currentLocation.lng], { icon })
                    .addTo(map)
                    .bindPopup('<strong>\u73fe\u5728\u5730</strong>');
            }

            // Load nearby spots
            loadNearbySpots();
        },
        (error) => {
            console.error('Geolocation error:', error);
            locationEl.textContent = '\u4f4d\u7f6e\u60c5\u5831\u3092\u53d6\u5f97\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f';
        },
        {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 60000
        }
    );
}

// Load all spots
async function loadSpots() {
    try {
        const url = activeFilter === 'all' 
            ? '/api/spots' 
            : `/api/spots?category=${activeFilter}`;
        
        const response = await fetch(url);
        spots = await response.json();
        
        renderSpotsList();
        renderSpotMarkers();
    } catch (error) {
        console.error('Error loading spots:', error);
        document.getElementById('spots-container').innerHTML = 
            '<p class="loading">\u30b9\u30dd\u30c3\u30c8\u306e\u8aad\u307f\u8fbc\u307f\u306b\u5931\u6557\u3057\u307e\u3057\u305f</p>';
    }
}

// Load nearby spots
async function loadNearbySpots() {
    if (!currentLocation) return;
    
    try {
        const response = await fetch(
            `/api/nearby?lat=${currentLocation.lat}&lng=${currentLocation.lng}&limit=20`
        );
        const nearbySpots = await response.json();
        
        // Update spots with distance info
        spots = nearbySpots.map(spot => ({
            ...spot,
            distance: spot.distance
        }));
        
        renderSpotsList();
        renderSpotMarkers();
    } catch (error) {
        console.error('Error loading nearby spots:', error);
    }
}

// Render spots list in sidebar
function renderSpotsList() {
    const container = document.getElementById('spots-container');
    
    const filteredSpots = activeFilter === 'all' 
        ? spots 
        : spots.filter(s => s.category === activeFilter);
    
    if (!filteredSpots || filteredSpots.length === 0) {
        container.innerHTML = '<p class="loading">\u30b9\u30dd\u30c3\u30c8\u304c\u3042\u308a\u307e\u305b\u3093</p>';
        return;
    }

    container.innerHTML = filteredSpots.map(spot => `
        <div class="spot-card" data-id="${spot.id}" onclick="focusSpot(${spot.id})">
            <span class="category-badge ${spot.category}">
                ${categoryIcons[spot.category]} ${categoryLabels[spot.category]}
            </span>
            <h3>${escapeHtml(spot.name)}</h3>
            ${spot.description ? `<p>${escapeHtml(spot.description)}</p>` : ''}
            ${spot.distance ? `<p class="distance">\ud83d\udccd ${spot.distance.toFixed(1)} km</p>` : ''}
            ${spot.rating > 0 ? `<p>\u2b50 ${spot.rating}</p>` : ''}
            <div class="spot-actions">
                <button class="btn btn-danger" onclick="event.stopPropagation(); deleteSpot(${spot.id})">
                    \u524a\u9664
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
                    ${spot.address ? `<p>\ud83d\udccd ${escapeHtml(spot.address)}</p>` : ''}
                    ${spot.rating > 0 ? `<p class="rating">\u2b50 ${spot.rating}</p>` : ''}
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
    if (!confirm('\u3053\u306e\u30b9\u30dd\u30c3\u30c8\u3092\u524a\u9664\u3057\u307e\u3059\u304b\uff1f')) return;

    try {
        const response = await fetch(`/api/spots/${id}`, {
            method: 'DELETE'
        });

        if (response.ok) {
            showNotification('\u30b9\u30dd\u30c3\u30c8\u3092\u524a\u9664\u3057\u307e\u3057\u305f');
            loadSpots();
        } else {
            throw new Error('Failed to delete');
        }
    } catch (error) {
        console.error('Error deleting spot:', error);
        showNotification('\u524a\u9664\u306b\u5931\u6557\u3057\u307e\u3057\u305f', true);
    }
}

// Setup event listeners
function setupEventListeners() {
    // Refresh location button
    document.getElementById('refresh-location').addEventListener('click', getCurrentLocation);

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
            showNotification('\u73fe\u5728\u5730\u304c\u53d6\u5f97\u3067\u304d\u3066\u3044\u307e\u305b\u3093', true);
        }
    });

    // Pick on map button
    document.getElementById('pick-on-map').addEventListener('click', () => {
        pickingLocation = true;
        modal.style.display = 'none';
        map.getContainer().style.cursor = 'crosshair';
        showNotification('\u5730\u56f3\u3092\u30af\u30ea\u30c3\u30af\u3057\u3066\u4f4d\u7f6e\u3092\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044');
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
                showNotification('\u30b9\u30dd\u30c3\u30c8\u3092\u8ffd\u52a0\u3057\u307e\u3057\u305f');
                modal.style.display = 'none';
                e.target.reset();
                loadSpots();
            } else {
                throw new Error('Failed to add spot');
            }
        } catch (error) {
            console.error('Error adding spot:', error);
            showNotification('\u8ffd\u52a0\u306b\u5931\u6557\u3057\u307e\u3057\u305f', true);
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
