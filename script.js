/* =========================================================
   PHYNEX — CART + PRODUCT INTERACTIVITY
   ========================================================= */

(function () {
    'use strict';

    const CART_KEY = 'phynexCart';

    /* ---------- Helpers ---------- */

    function parsePrice(value) {
        return parseInt(String(value || '').replace(/[^\d]/g, ''), 10) || 0;
    }

    function money(amount) {
        return 'KSh ' + Number(amount || 0).toLocaleString('en-KE');
    }

    function slugify(text) {
        return String(text || 'product')
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '');
    }

    function getCart() {
        try {
            const cart = JSON.parse(localStorage.getItem(CART_KEY));
            return Array.isArray(cart) ? cart : [];
        } catch (error) {
            return [];
        }
    }

    function saveCart(cart) {
        localStorage.setItem(CART_KEY, JSON.stringify(cart));
        updateCartCount();
    }

    /* ---------- Cart Count ---------- */

    function updateCartCount() {
        const cart = getCart();

        const count = cart.reduce(function (total, item) {
            return total + Math.max(
                1,
                Number(item.qty || item.quantity) || 1
            );
        }, 0);

        const header = document.getElementById('cart-count');
        if (header) {
            header.textContent =
                count + (count === 1 ? ' item' : ' items');
        }

        const mobile = document.getElementById('mbnCartCount');
        if (mobile) {
            mobile.textContent = count;
            mobile.style.display = count > 0 ? 'flex' : 'none';
        }
    }

    /* ---------- Toast ---------- */

    function showToast(message) {
        const old = document.getElementById('phynexToast');
        if (old) old.remove();

        const toast = document.createElement('div');
        toast.id = 'phynexToast';
        toast.textContent = message;

        toast.style.cssText =
            'position:fixed;' +
            'left:50%;' +
            'bottom:80px;' +
            'transform:translateX(-50%);' +
            'background:#071a49;' +
            'color:white;' +
            'padding:12px 20px;' +
            'border-radius:8px;' +
            'font-size:14px;' +
            'font-weight:700;' +
            'z-index:999999;' +
            'box-shadow:0 8px 25px rgba(0,0,0,.3);';

        document.body.appendChild(toast);

        setTimeout(function () {
            toast.remove();
        }, 2000);
    }

    /* ---------- Get Product From Card ---------- */

    function getProductFromCard(card) {
        const nameElement = card.querySelector('.product-name');
        const priceElement = card.querySelector('.price');
        const oldPriceElement = card.querySelector('.old-price');
        const discountElement = card.querySelector('.discount');
        const imageElement = card.querySelector('.product-image img');
        const ratingElement = card.querySelector('.rating');

        const name = nameElement
            ? nameElement.textContent.trim()
            : 'Product';

        let priceText = '';

        if (priceElement) {
            let firstText = '';

            for (const node of priceElement.childNodes) {
                if (node.nodeType === Node.TEXT_NODE) {
                    firstText += node.textContent;
                }
            }

            priceText = firstText.trim();

            if (!priceText) {
                priceText = priceElement.textContent.trim();
            }
        }

        const price = parsePrice(priceText);

        return {
            id: card.dataset.productId || slugify(name),
            name: name,
            price: price,
            priceDisplay: money(price),
            oldPrice: oldPriceElement
                ? oldPriceElement.textContent.trim()
                : '',
            discount: discountElement
                ? discountElement.textContent.trim()
                : '',
            image: imageElement
                ? imageElement.src
                : '',
            rating: ratingElement
                ? ratingElement.textContent.trim()
                : '',
            description: card.dataset.description || '',
            specifications: card.dataset.specifications || ''
        };
    }

    /* ---------- ADD TO CART ---------- */

    function addProduct(product, quantity) {
        if (!product) return;

        quantity = Math.max(1, Number(quantity) || 1);

        const cart = getCart();

        const existing = cart.find(function (item) {
            return item.id === product.id;
        });

        if (existing) {

            const oldQty = Number(
                existing.qty || existing.quantity
            ) || 1;

            existing.qty = oldQty + quantity;

            // Keep compatibility with cart.html
            existing.quantity = existing.qty;

        } else {

            cart.push({
                id: product.id,
                name: product.name,
                price: Number(product.price) || 0,
                priceDisplay: product.priceDisplay,
                oldPrice: product.oldPrice || '',
                discount: product.discount || '',
                image: product.image || '',
                rating: product.rating || '',
                description: product.description || '',
                specifications: product.specifications || '',
                qty: quantity,
                quantity: quantity
            });
        }

        saveCart(cart);

        showToast(
            quantity + ' × ' +
            product.name +
            ' added to cart'
        );
    }

    /* ---------- Card Add To Cart ---------- */

    window.addToCart = function (button) {

        if (!button) return;

        const card = button.closest('.product');

        if (!card) {
            console.error('PHYNEX: Product card not found.');
            return;
        }

        const product = getProductFromCard(card);

        addProduct(product, 1);
    };

    /* ---------- Card Buy Now ---------- */

    window.buyNowFromCard = function (button) {

        if (!button) return;

        const card = button.closest('.product');

        if (!card) return;

        const product = getProductFromCard(card);

        const buyNowItem = {
            ...product,
            qty: 1,
            quantity: 1
        };

        localStorage.setItem(
            'phynexBuyNow',
            JSON.stringify([buyNowItem])
        );

        window.location.href = 'checkout.html';
    };

    /* =========================================================
       PRODUCT POPUP
       ========================================================= */

    let currentProduct = null;

    function openProductPopup(product) {

        currentProduct = product;

        const image =
            document.getElementById('modalProductImage');

        const price =
            document.getElementById('modalProductPrice');

        const oldPrice =
            document.getElementById('modalOldPrice');

        const discount =
            document.getElementById('modalProductDiscount');

        const name =
            document.getElementById('modalProductName');

        const rating =
            document.getElementById('modalProductRating');

        const description =
            document.getElementById('modalProductDescription');

        const specifications =
            document.getElementById(
                'modalProductSpecifications'
            );

        const quantity =
            document.getElementById('productQty');

        const popup =
            document.getElementById('productPopup');

        if (image) image.src = product.image || '';

        if (price) {
            price.textContent =
                money(product.price);
        }

        if (oldPrice) {
            oldPrice.textContent =
                product.oldPrice || '';
        }

        if (discount) {
            discount.textContent =
                product.discount || '';
        }

        if (name) {
            name.textContent =
                product.name;
        }

        if (rating) {
            rating.textContent =
                product.rating || '';
        }

        if (description) {
            description.textContent =
                product.description ||
                'No description available.';
        }

        if (specifications) {
            specifications.textContent =
                product.specifications ||
                'No specifications listed.';
        }

        if (quantity) {
            quantity.textContent = '1';
        }

        if (popup) {
            popup.classList.add('show');
        }

        document.body.style.overflow = 'hidden';
    }

    function closeProductPopup() {

        const popup =
            document.getElementById('productPopup');

        if (popup) {
            popup.classList.remove('show');
        }

        document.body.style.overflow = '';
        currentProduct = null;
    }

    /* =========================================================
       SEARCH
       ========================================================= */

    function getProducts() {

        return Array.from(
            document.querySelectorAll(
                '.products .product'
            )
        ).filter(function (card) {

            return !card.closest(
                '#newArrivalsGrid'
            );

        });
    }

    function showAllProducts() {

        getProducts().forEach(function (card) {
            card.style.display = '';
        });
    }

    function scrollToProducts() {

        const section =
            document.getElementById(
                'productsSection'
            );

        if (section) {
            section.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }
    }

    function filterCategory(category) {

        let found = 0;

        getProducts().forEach(function (card) {

            const categories =
                (card.dataset.category || '')
                    .split(' ');

            const match =
                categories.includes(category);

            card.style.display =
                match ? '' : 'none';

            if (match) found++;
        });

        scrollToProducts();

        showToast(
            found +
            (found === 1
                ? ' product'
                : ' products') +
            ' in ' +
            category
        );
    }

    function searchProducts() {

        const input =
            document.getElementById(
                'searchInput'
            );

        if (!input) return;

        const query =
            input.value.trim().toLowerCase();

        if (!query) {
            showAllProducts();
            return;
        }

        let found = 0;

        getProducts().forEach(function (card) {

            const nameElement =
                card.querySelector(
                    '.product-name'
                );

            const name =
                nameElement
                    ? nameElement.textContent
                        .toLowerCase()
                    : '';

            const match =
                name.includes(query);

            card.style.display =
                match ? '' : 'none';

            if (match) found++;
        });

        scrollToProducts();

        showToast(
            found +
            (found === 1
                ? ' result'
                : ' results') +
            ' for "' +
            input.value.trim() +
            '"'
        );
    }

    /* =========================================================
       FLASH TIMER
       ========================================================= */

    function startFlashTimer() {

        const timer =
            document.getElementById(
                'flashDealsTimer'
            );

        if (!timer) return;

        let seconds = 3 * 60 * 60;

        function pad(number) {
            return String(number).padStart(2, '0');
        }

        function tick() {

            if (seconds <= 0) {
                seconds = 3 * 60 * 60;
            }

            const hours =
                Math.floor(seconds / 3600);

            const minutes =
                Math.floor(
                    (seconds % 3600) / 60
                );

            const secs =
                seconds % 60;

            timer.textContent =
                'Ends in: ' +
                pad(hours) +
                ' : ' +
                pad(minutes) +
                ' : ' +
                pad(secs);

            seconds--;
        }

        tick();

        setInterval(tick, 1000);
    }

    /* =========================================================
       PAGE START
       ========================================================= */

    document.addEventListener(
        'DOMContentLoaded',
        function () {

            updateCartCount();

            startFlashTimer();

            /* Hero Shop Button */

            const heroShop =
                document.getElementById(
                    'heroShopButton'
                );

            if (heroShop) {

                heroShop.addEventListener(
                    'click',
                    function () {

                        showAllProducts();
                        scrollToProducts();

                    }
                );
            }

            /* Hero Categories */

            document
                .querySelectorAll(
                    '.hero-links a[data-category]'
                )
                .forEach(function (link) {

                    link.addEventListener(
                        'click',
                        function () {

                            filterCategory(
                                link.dataset.category
                            );

                        }
                    );

                });

            /* Category Tiles */

            document
                .querySelectorAll(
                    '.category[data-category]'
                )
                .forEach(function (tile) {

                    tile.style.cursor =
                        'pointer';

                    tile.addEventListener(
                        'click',
                        function () {

                            filterCategory(
                                tile.dataset.category
                            );

                        }
                    );

                });

            /* Search */

            const searchButton =
                document.getElementById(
                    'searchButton'
                );

            const searchInput =
                document.getElementById(
                    'searchInput'
                );

            if (searchButton) {

                searchButton.addEventListener(
                    'click',
                    searchProducts
                );

            }

            if (searchInput) {

                searchInput.addEventListener(
                    'keydown',
                    function (event) {

                        if (
                            event.key ===
                            'Enter'
                        ) {
                            searchProducts();
                        }

                    }
                );

            }

            /* Product Popup */

            getProducts().forEach(
                function (card) {

                    const triggers =
                        card.querySelectorAll(
                            '.product-image img,' +
                            '.product-name'
                        );

                    triggers.forEach(
                        function (element) {

                            element.style.cursor =
                                'pointer';

                            element.addEventListener(
                                'click',
                                function () {

                                    openProductPopup(
                                        getProductFromCard(
                                            card
                                        )
                                    );

                                }
                            );

                        }
                    );

                }
            );

            /* Close Popup */

            const closeButton =
                document.querySelector(
                    '.product-popup-close'
                );

            if (closeButton) {

                closeButton.addEventListener(
                    'click',
                    closeProductPopup
                );

            }

            document.addEventListener(
                'keydown',
                function (event) {

                    if (
                        event.key ===
                        'Escape'
                    ) {
                        closeProductPopup();
                    }

                }
            );

            /* Quantity + / - */

            const quantity =
                document.getElementById(
                    'productQty'
                );

            const decrease =
                document.getElementById(
                    'decreaseQty'
                );

            const increase =
                document.getElementById(
                    'increaseQty'
                );

            if (decrease && quantity) {

                decrease.addEventListener(
                    'click',
                    function () {

                        let value =
                            Number(
                                quantity.textContent
                            ) || 1;

                        value =
                            Math.max(
                                1,
                                value - 1
                            );

                        quantity.textContent =
                            value;

                    }
                );

            }

            if (increase && quantity) {

                increase.addEventListener(
                    'click',
                    function () {

                        let value =
                            Number(
                                quantity.textContent
                            ) || 1;

                        value++;

                        quantity.textContent =
                            value;

                    }
                );

            }

            /* Popup Add To Cart */

            const modalAdd =
                document.getElementById(
                    'modalAddToCart'
                );

            if (modalAdd) {

                modalAdd.addEventListener(
                    'click',
                    function () {

                        if (!currentProduct)
                            return;

                        const qty =
                            Number(
                                quantity
                                    ? quantity.textContent
                                    : 1
                            ) || 1;

                        addProduct(
                            currentProduct,
                            qty
                        );

                    }
                );

            }

            /* Popup Order Now */

            const modalBuy =
                document.getElementById(
                    'modalBuyNow'
                );

            if (modalBuy) {

                modalBuy.addEventListener(
                    'click',
                    function () {

                        if (!currentProduct)
                            return;

                        const qty =
                            Number(
                                quantity
                                    ? quantity.textContent
                                    : 1
                            ) || 1;

                        const item = {
                            ...currentProduct,
                            qty: qty,
                            quantity: qty
                        };

                        localStorage.setItem(
                            'phynexBuyNow',
                            JSON.stringify(
                                [item]
                            )
                        );

                        window.location.href =
                            'checkout.html';

                    }
                );

            }

        }
    );

    /* Update cart if another tab changes it */

    window.addEventListener(
        'storage',
        function (event) {

            if (
                event.key === CART_KEY
            ) {
                updateCartCount();
            }

        }
    );

})();