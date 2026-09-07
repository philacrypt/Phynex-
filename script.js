/* =========================================================
   PHYNEX — site interactivity
   Handles: cart (add/buy/count), product quick-view popup,
   search, category filtering, hero "Shop now", flash timer.
   Cart is stored in localStorage under "phynexCart" so the
   count/badges survive page reloads. cart.html / checkout.html
   should read the same key to list items (not included here).
   ========================================================= */

(function () {
    'use strict';

    /* ---------- helpers ---------- */

    function parsePrice(text) {
        return parseInt(String(text || '').replace(/[^\d]/g, ''), 10) || 0;
    }

    function formatKsh(n) {
        return 'KSh ' + Number(n || 0).toLocaleString('en-KE');
    }

    function slugify(text) {
        return String(text || 'item')
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '');
    }

    function getCart() {
        try {
            return JSON.parse(localStorage.getItem('phynexCart')) || [];
        } catch (e) {
            return [];
        }
    }

    function saveCart(cart) {
        localStorage.setItem('phynexCart', JSON.stringify(cart));
        updateCartCountDisplay();
    }

    function updateCartCountDisplay() {
        var cart = getCart();
        var totalQty = cart.reduce(function (sum, item) { return sum + (item.qty || 1); }, 0);
        var el = document.getElementById('cart-count');
        if (el) el.textContent = totalQty + (totalQty === 1 ? ' item' : ' items');
    }

    function addItemToCart(product, qty) {
        if (!product) return;
        qty = qty || 1;
        var cart = getCart();
        var existing = cart.find(function (i) { return i.id === product.id; });
        if (existing) {
            existing.qty += qty;
        } else {
            cart.push(Object.assign({}, product, { qty: qty }));
        }
        saveCart(cart);
        showToast((qty > 1 ? qty + '× ' : '') + product.name + ' added to cart');
    }

    /* ---------- toast feedback ---------- */

    function showToast(message) {
        var existing = document.getElementById('phynexToast');
        if (existing) existing.remove();

        var toast = document.createElement('div');
        toast.id = 'phynexToast';
        toast.textContent = message;
        toast.style.cssText = [
            'position:fixed', 'left:50%', 'bottom:78px', 'transform:translateX(-50%) translateY(10px)',
            'background:#071a49', 'color:#fff', 'padding:10px 18px', 'border-radius:8px',
            'font-size:13px', 'font-weight:600', 'z-index:200000', 'opacity:0',
            'transition:opacity .25s ease, transform .25s ease', 'box-shadow:0 8px 24px rgba(7,26,73,.25)',
            'max-width:88%', 'text-align:center'
        ].join(';');
        document.body.appendChild(toast);

        requestAnimationFrame(function () {
            toast.style.opacity = '1';
            toast.style.transform = 'translateX(-50%) translateY(0)';
        });

        window.setTimeout(function () {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(-50%) translateY(10px)';
            window.setTimeout(function () { toast.remove(); }, 250);
        }, 1800);
    }

    /* ---------- reading product data off a card ---------- */

    function getProductDataFromCard(card) {
        var nameEl = card.querySelector('.product-name');
        var priceEl = card.querySelector('.price');
        var oldPriceEl = card.querySelector('.old-price');
        var discountEl = card.querySelector('.discount');
        var imgEl = card.querySelector('.product-image img');
        var ratingEl = card.querySelector('.rating');

        var name = nameEl ? nameEl.textContent.trim() : 'Product';
        var priceText = '';
        if (priceEl) {
            // .price contains "KSh X" as its first text node, plus a
            // nested .old-price span — grab only the first text node.
            var firstNode = priceEl.childNodes[0];
            priceText = firstNode ? firstNode.textContent.trim() : priceEl.textContent.trim();
        }

        return {
            id: slugify(name),
            name: name,
            price: parsePrice(priceText),
            priceDisplay: priceText || formatKsh(0),
            oldPrice: oldPriceEl ? oldPriceEl.textContent.trim() : '',
            discount: discountEl ? discountEl.textContent.trim() : '',
            image: imgEl ? imgEl.src : '',
            rating: ratingEl ? ratingEl.textContent.trim() : '',
            description: card.dataset.description || '',
            specifications: card.dataset.specifications || ''
        };
    }

    /* ---------- add to cart / buy now (card buttons) ---------- */

    window.addToCart = function (button) {
        var card = button.closest('.product');
        if (!card) return;
        addItemToCart(getProductDataFromCard(card), 1);
    };

    window.buyNowFromCard = function (button) {
        var card = button.closest('.product');
        if (!card) return;
        addItemToCart(getProductDataFromCard(card), 1);
        window.location.href = 'checkout.html';
    };

    /* ---------- product quick-view popup ---------- */

    var currentPopupProduct = null;

    function openProductPopup(product) {
        currentPopupProduct = product;

        var img = document.getElementById('modalProductImage');
        var price = document.getElementById('modalProductPrice');
        var oldPrice = document.getElementById('modalOldPrice');
        var discount = document.getElementById('modalProductDiscount');
        var name = document.getElementById('modalProductName');
        var rating = document.getElementById('modalProductRating');
        var description = document.getElementById('modalProductDescription');
        var specs = document.getElementById('modalProductSpecifications');
        var qty = document.getElementById('productQty');
        var popup = document.getElementById('productPopup');

        if (img) img.src = product.image;
        if (price) price.textContent = product.priceDisplay;
        if (oldPrice) oldPrice.textContent = product.oldPrice;
        if (discount) discount.textContent = product.discount;
        if (name) name.textContent = product.name;
        if (rating) rating.textContent = product.rating;
        if (description) description.textContent = product.description || 'No description available for this product yet.';
        if (specs) specs.textContent = product.specifications || 'No specifications listed for this product yet.';
        if (qty) qty.textContent = '1';

        if (popup) popup.classList.add('show');
        document.body.style.overflow = 'hidden';
    }

    function closeProductPopup() {
        var popup = document.getElementById('productPopup');
        if (popup) popup.classList.remove('show');
        document.body.style.overflow = '';
    }

    /* ---------- category filtering & search ---------- */

    function getMainProductCards() {
        // Excludes the cloned cards inside the New Arrivals strip so
        // filtering/searching only affects the real catalog grid.
        return Array.from(document.querySelectorAll('.products .product')).filter(function (card) {
            return !card.closest('#newArrivalsGrid');
        });
    }

    function showAllProducts() {
        getMainProductCards().forEach(function (card) { card.style.display = ''; });
    }

    function scrollToProducts() {
        var target = document.getElementById('productsSection');
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function filterByCategory(category) {
        var count = 0;
        getMainProductCards().forEach(function (card) {
            var cats = (card.dataset.category || '').split(' ');
            var match = cats.indexOf(category) !== -1;
            card.style.display = match ? '' : 'none';
            if (match) count++;
        });
        scrollToProducts();
        showToast(count + (count === 1 ? ' product' : ' products') + ' in ' + category);
    }

    function runSearch() {
        var input = document.getElementById('searchInput');
        if (!input) return;
        var query = input.value.trim().toLowerCase();

        if (!query) {
            showAllProducts();
            return;
        }

        var count = 0;
        getMainProductCards().forEach(function (card) {
            var nameEl = card.querySelector('.product-name');
            var name = nameEl ? nameEl.textContent.toLowerCase() : '';
            var match = name.indexOf(query) !== -1;
            card.style.display = match ? '' : 'none';
            if (match) count++;
        });

        scrollToProducts();
        showToast(count + (count === 1 ? ' result' : ' results') + ' for "' + input.value.trim() + '"');
    }

    /* ---------- flash deals countdown ---------- */

    function startFlashTimer() {
        var el = document.getElementById('flashDealsTimer');
        if (!el) return;

        var totalSeconds = 3 * 3600; // resets to 3:00:00 each page load

        function pad(n) { return String(n).padStart(2, '0'); }

        function tick() {
            if (totalSeconds <= 0) totalSeconds = 3 * 3600;
            var h = Math.floor(totalSeconds / 3600);
            var m = Math.floor((totalSeconds % 3600) / 60);
            var s = totalSeconds % 60;
            el.textContent = 'Ends in: ' + pad(h) + ' : ' + pad(m) + ' : ' + pad(s);
            totalSeconds--;
        }

        tick();
        window.setInterval(tick, 1000);
    }

    /* ---------- wire everything up ---------- */

    document.addEventListener('DOMContentLoaded', function () {

        updateCartCountDisplay();
        startFlashTimer();

        /* Hero "Shop now" — clears any filter and scrolls to the grid */
        var heroShopButton = document.getElementById('heroShopButton');
        if (heroShopButton) {
            heroShopButton.addEventListener('click', function () {
                showAllProducts();
                scrollToProducts();
            });
        }

        /* Hero quick-category links */
        document.querySelectorAll('.hero-links a[data-category]').forEach(function (a) {
            a.addEventListener('click', function () {
                filterByCategory(a.dataset.category);
            });
        });

        /* "Shop by Category" tiles */
        document.querySelectorAll('.category[data-category]').forEach(function (tile) {
            tile.style.cursor = 'pointer';
            tile.addEventListener('click', function () {
                filterByCategory(tile.dataset.category);
            });
        });

        /* Search */
        var searchButton = document.getElementById('searchButton');
        var searchInput = document.getElementById('searchInput');
        if (searchButton) searchButton.addEventListener('click', runSearch);
        if (searchInput) {
            searchInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') runSearch();
            });
        }

        /* Open the quick-view popup from the product image or name */
        document.querySelectorAll('.products .product').forEach(function (card) {
            var triggers = card.querySelectorAll('.product-image img, .product-name');
            triggers.forEach(function (el) {
                el.style.cursor = 'pointer';
                el.addEventListener('click', function () {
                    openProductPopup(getProductDataFromCard(card));
                });
            });
        });

        /* Popup close (back arrow) + Escape key */
        var closeBtn = document.querySelector('.product-popup-close');
        if (closeBtn) closeBtn.addEventListener('click', closeProductPopup);
        document.addEventListener('keydown', function (e) {
            var popup = document.getElementById('productPopup');
            if (e.key === 'Escape' && popup && popup.classList.contains('show')) {
                closeProductPopup();
            }
        });

        /* Popup quantity stepper */
        var qtyEl = document.getElementById('productQty');
        var decreaseBtn = document.getElementById('decreaseQty');
        var increaseBtn = document.getElementById('increaseQty');
        if (decreaseBtn && qtyEl) {
            decreaseBtn.addEventListener('click', function () {
                var val = Math.max(1, Number(qtyEl.textContent) - 1);
                qtyEl.textContent = String(val);
            });
        }
        if (increaseBtn && qtyEl) {
            increaseBtn.addEventListener('click', function () {
                var val = Number(qtyEl.textContent) + 1;
                qtyEl.textContent = String(val);
            });
        }

        /* Popup Add to Cart / Order Now */
        var modalAddToCart = document.getElementById('modalAddToCart');
        var modalBuyNow = document.getElementById('modalBuyNow');
        if (modalAddToCart) {
            modalAddToCart.addEventListener('click', function () {
                if (!currentPopupProduct) return;
                var qty = Number((document.getElementById('productQty') || {}).textContent) || 1;
                addItemToCart(currentPopupProduct, qty);
            });
        }
        if (modalBuyNow) {
            modalBuyNow.addEventListener('click', function () {
                if (!currentPopupProduct) return;
                var qty = Number((document.getElementById('productQty') || {}).textContent) || 1;
                addItemToCart(currentPopupProduct, qty);
                window.location.href = 'checkout.html';
            });
        }
    });

})();