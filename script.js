/* =========================================================
   PHYNEX — MAIN JAVASCRIPT
   CART + QUANTITY + PRODUCT POPUP + SEARCH + CATEGORIES
   + ADVERTISEMENT CAROUSEL
   ========================================================= */

(function () {
    'use strict';

    const CART_KEY = 'phynexCart';

    /* =====================================================
       BASIC HELPERS
       ===================================================== */

    function parsePrice(value) {
        return parseInt(
            String(value || '').replace(/[^\d]/g, ''),
            10
        ) || 0;
    }

    function money(value) {
        return 'KSh ' + Number(value || 0).toLocaleString('en-KE');
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
            const cart = JSON.parse(
                localStorage.getItem(CART_KEY)
            );

            return Array.isArray(cart) ? cart : [];
        } catch (error) {
            return [];
        }
    }

    function saveCart(cart) {
        localStorage.setItem(
            CART_KEY,
            JSON.stringify(cart)
        );

        updateCartCount();
    }

    /* =====================================================
       CART COUNT
       ===================================================== */

    function updateCartCount() {

        const cart = getCart();

        let total = 0;

        cart.forEach(function (item) {

            const quantity = Number(
                item.qty || item.quantity
            ) || 1;

            total += Math.max(1, quantity);
        });

        const cartCount =
            document.getElementById('cart-count');

        if (cartCount) {
            cartCount.textContent =
                total +
                (total === 1 ? ' item' : ' items');
        }

        const mobileCount =
            document.getElementById('mbnCartCount');

        if (mobileCount) {
            mobileCount.textContent = total;

            mobileCount.style.display =
                total > 0 ? 'flex' : 'none';
        }
    }

    /* =====================================================
       TOAST MESSAGE
       ===================================================== */

    function showToast(message) {

        const old =
            document.getElementById('phynexToast');

        if (old) old.remove();

        const toast =
            document.createElement('div');

        toast.id = 'phynexToast';
        toast.textContent = message;

        toast.style.cssText =
            'position:fixed;' +
            'left:50%;' +
            'bottom:80px;' +
            'transform:translateX(-50%);' +
            'background:#071a49;' +
            'color:#fff;' +
            'padding:12px 20px;' +
            'border-radius:10px;' +
            'font-size:14px;' +
            'font-weight:700;' +
            'z-index:999999;' +
            'box-shadow:0 8px 25px rgba(0,0,0,.3);' +
            'max-width:90%;' +
            'text-align:center;';

        document.body.appendChild(toast);

        setTimeout(function () {
            if (toast) toast.remove();
        }, 2000);
    }

    /* =====================================================
       GET PRODUCT INFORMATION
       ===================================================== */

    function getProductFromCard(card) {

        const nameElement =
            card.querySelector('.product-name');

        const priceElement =
            card.querySelector('.price');

        const oldPriceElement =
            card.querySelector('.old-price');

        const discountElement =
            card.querySelector('.discount');

        const imageElement =
            card.querySelector('.product-image img');

        const ratingElement =
            card.querySelector('.rating');

        const name =
            nameElement
                ? nameElement.textContent.trim()
                : 'Product';

        let priceText = '';

        if (priceElement) {

            let text = '';

            priceElement.childNodes.forEach(
                function (node) {

                    if (
                        node.nodeType ===
                        Node.TEXT_NODE
                    ) {
                        text += node.textContent;
                    }

                }
            );

            priceText = text.trim();

            if (!priceText) {
                priceText =
                    priceElement.textContent.trim();
            }
        }

        const price =
            parsePrice(priceText);

        return {
            id:
                card.dataset.productId ||
                slugify(name),

            name: name,

            price: price,

            priceDisplay:
                money(price),

            oldPrice:
                oldPriceElement
                    ? oldPriceElement.textContent.trim()
                    : '',

            discount:
                discountElement
                    ? discountElement.textContent.trim()
                    : '',

            image:
                imageElement
                    ? imageElement.src
                    : '',

            rating:
                ratingElement
                    ? ratingElement.textContent.trim()
                    : '',

            description:
                card.dataset.description || '',

            specifications:
                card.dataset.specifications || ''
        };
    }

    /* =====================================================
       ADD PRODUCT TO CART
       ===================================================== */

    function addProductToCart(product, quantity) {

        if (!product) return;

        quantity =
            Math.max(
                1,
                Number(quantity) || 1
            );

        const cart = getCart();

        const existing =
            cart.find(function (item) {
                return item.id === product.id;
            });

        if (existing) {

            const oldQuantity =
                Number(
                    existing.qty ||
                    existing.quantity
                ) || 1;

            existing.qty =
                oldQuantity + quantity;

            existing.quantity =
                existing.qty;

        } else {

            cart.push({

                id: product.id,

                name: product.name,

                price:
                    Number(product.price) || 0,

                priceDisplay:
                    product.priceDisplay,

                oldPrice:
                    product.oldPrice || '',

                discount:
                    product.discount || '',

                image:
                    product.image || '',

                rating:
                    product.rating || '',

                description:
                    product.description || '',

                specifications:
                    product.specifications || '',

                qty: quantity,

                quantity: quantity
            });
        }

        saveCart(cart);

        showToast(
            quantity +
            ' × ' +
            product.name +
            ' added to cart'
        );
    }

    /* =====================================================
       CARD — ADD TO CART
       ===================================================== */

    window.addToCart = function (button) {

        if (!button) return;

        const card =
            button.closest('.product');

        if (!card) {
            console.error(
                'PHYNEX: Product card not found.'
            );
            return;
        }

        const product =
            getProductFromCard(card);

        addProductToCart(
            product,
            1
        );
    };

    /* =====================================================
       CARD — BUY NOW
       ===================================================== */

    window.buyNowFromCard = function (button) {

        if (!button) return;

        const card =
            button.closest('.product');

        if (!card) return;

        const product =
            getProductFromCard(card);

        const item = {
            ...product,
            qty: 1,
            quantity: 1
        };

        localStorage.setItem(
            'phynexBuyNow',
            JSON.stringify([item])
        );

        window.location.href =
            'checkout.html';
    };

    /* =====================================================
       PRODUCT POPUP
       ===================================================== */

    let currentProduct = null;

    function openProductPopup(product) {

        currentProduct = product;

        const image =
            document.getElementById(
                'modalProductImage'
            );

        const price =
            document.getElementById(
                'modalProductPrice'
            );

        const oldPrice =
            document.getElementById(
                'modalOldPrice'
            );

        const discount =
            document.getElementById(
                'modalProductDiscount'
            );

        const name =
            document.getElementById(
                'modalProductName'
            );

        const rating =
            document.getElementById(
                'modalProductRating'
            );

        const description =
            document.getElementById(
                'modalProductDescription'
            );

        const specifications =
            document.getElementById(
                'modalProductSpecifications'
            );

        const quantity =
            document.getElementById(
                'productQty'
            );

        const popup =
            document.getElementById(
                'productPopup'
            );

        if (image) {
            image.src =
                product.image || '';
        }

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

        document.body.style.overflow =
            'hidden';
    }

    function closeProductPopup() {

        const popup =
            document.getElementById(
                'productPopup'
            );

        if (popup) {
            popup.classList.remove('show');
        }

        document.body.style.overflow = '';

        currentProduct = null;
    }

    /* =====================================================
       PRODUCT FILTERING
       ===================================================== */

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

        getProducts().forEach(
            function (card) {
                card.style.display = '';
            }
        );
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

        getProducts().forEach(
            function (card) {

                const categories =
                    (
                        card.dataset.category ||
                        ''
                    ).split(' ');

                const match =
                    categories.includes(
                        category
                    );

                card.style.display =
                    match ? '' : 'none';

                if (match) found++;
            }
        );

        scrollToProducts();

        showToast(
            found +
            (
                found === 1
                    ? ' product'
                    : ' products'
            ) +
            ' in ' +
            category
        );
    }

    /* =====================================================
       SEARCH
       ===================================================== */

    function searchProducts() {

        const input =
            document.getElementById(
                'searchInput'
            );

        if (!input) return;

        const query =
            input.value
                .trim()
                .toLowerCase();

        if (!query) {

            showAllProducts();

            return;
        }

        let found = 0;

        getProducts().forEach(
            function (card) {

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
            }
        );

        scrollToProducts();

        showToast(
            found +
            (
                found === 1
                    ? ' result'
                    : ' results'
            ) +
            ' for "' +
            input.value.trim() +
            '"'
        );
    }

    /* =====================================================
       FLASH DEAL TIMER
       ===================================================== */

    function startFlashTimer() {

        const timer =
            document.getElementById(
                'flashDealsTimer'
            );

        if (!timer) return;

        let seconds =
            3 * 60 * 60;

        function pad(number) {
            return String(number)
                .padStart(2, '0');
        }

        function tick() {

            if (seconds <= 0) {
                seconds =
                    3 * 60 * 60;
            }

            const hours =
                Math.floor(
                    seconds / 3600
                );

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

        setInterval(
            tick,
            1000
        );
    }

    /* =====================================================
       ADVERTISEMENT CAROUSEL
       ===================================================== */

    function startAdCarousel() {

        const carousel =
            document.getElementById(
                'adCarousel'
            );

        const track =
            document.getElementById(
                'adCarouselTrack'
            );

        const slides =
            document.querySelectorAll(
                '#adCarouselTrack .ad-slide'
            );

        const dots =
            document.querySelectorAll(
                '#adCarouselDots span'
            );

        if (
            !carousel ||
            !track ||
            !slides.length
        ) {
            return;
        }

        let current = 0;

        let timer = null;

        const total =
            slides.length;

        function goToSlide(index) {

            if (index < 0) {
                index = total - 1;
            }

            if (index >= total) {
                index = 0;
            }

            current = index;

            track.style.transform =
                'translate3d(-' +
                (current * 100) +
                '%,0,0)';

            dots.forEach(
                function (dot, i) {

                    dot.classList.toggle(
                        'active',
                        i === current
                    );

                }
            );
        }

        function nextSlide() {

            goToSlide(
                current + 1
            );
        }

        function stop() {

            if (timer) {

                clearInterval(timer);

                timer = null;
            }
        }

        function start() {

            stop();

            timer =
                setInterval(
                    nextSlide,
                    3000
                );
        }

        /* Carousel dots */

        dots.forEach(
            function (dot, index) {

                dot.addEventListener(
                    'click',
                    function (event) {

                        event.preventDefault();
                        event.stopPropagation();

                        goToSlide(index);

                        start();
                    }
                );

            }
        );

        /* Touch swipe */

        let startX = 0;
        let endX = 0;

        carousel.addEventListener(
            'touchstart',
            function (event) {

                startX =
                    event.touches[0]
                        .clientX;

                stop();

            },
            { passive: true }
        );

        carousel.addEventListener(
            'touchmove',
            function (event) {

                endX =
                    event.touches[0]
                        .clientX;

            },
            { passive: true }
        );

        carousel.addEventListener(
            'touchend',
            function () {

                const distance =
                    startX - endX;

                if (distance > 50) {

                    goToSlide(
                        current + 1
                    );

                } else if (
                    distance < -50
                ) {

                    goToSlide(
                        current - 1
                    );
                }

                start();

            }
        );

        /* Start */

        goToSlide(0);

        start();
    }

    /* =====================================================
       PAGE LOAD
       ===================================================== */

    document.addEventListener(
        'DOMContentLoaded',
        function () {

            updateCartCount();

            startFlashTimer();

            startAdCarousel();

            /* ---------------------------------------------
               HERO SHOP BUTTON
               --------------------------------------------- */

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

            /* ---------------------------------------------
               HERO CATEGORY LINKS
               --------------------------------------------- */

            document
                .querySelectorAll(
                    '.hero-links a[data-category]'
                )
                .forEach(
                    function (link) {

                        link.addEventListener(
                            'click',
                            function () {

                                filterCategory(
                                    link.dataset.category
                                );

                            }
                        );

                    }
                );

            /* ---------------------------------------------
               CATEGORY TILES
               --------------------------------------------- */

            document
                .querySelectorAll(
                    '.category[data-category]'
                )
                .forEach(
                    function (tile) {

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

                    }
                );

            /* ---------------------------------------------
               SEARCH
               --------------------------------------------- */

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

            /* ---------------------------------------------
               PRODUCT IMAGE / NAME POPUP
               --------------------------------------------- */

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

            /* ---------------------------------------------
               CLOSE POPUP
               --------------------------------------------- */

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

            /* ---------------------------------------------
               PRODUCT QUANTITY
               --------------------------------------------- */

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

            if (
                decrease &&
                quantity
            ) {

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

            if (
                increase &&
                quantity
            ) {

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

            /* ---------------------------------------------
               POPUP ADD TO CART
               --------------------------------------------- */

            const modalAdd =
                document.getElementById(
                    'modalAddToCart'
                );

            if (modalAdd) {

                modalAdd.addEventListener(
                    'click',
                    function () {

                        if (
                            !currentProduct
                        ) return;

                        const qty =
                            Number(
                                quantity
                                    ? quantity.textContent
                                    : 1
                            ) || 1;

                        addProductToCart(
                            currentProduct,
                            qty
                        );

                    }
                );
            }

            /* ---------------------------------------------
               POPUP ORDER NOW
               --------------------------------------------- */

            const modalBuy =
                document.getElementById(
                    'modalBuyNow'
                );

            if (modalBuy) {

                modalBuy.addEventListener(
                    'click',
                    function () {

                        if (
                            !currentProduct
                        ) return;

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

    /* =====================================================
       UPDATE CART WHEN STORAGE CHANGES
       ===================================================== */

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