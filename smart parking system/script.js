let available = 9;

let booked = 3;

let currentSlot = null;

function bookSlot(slot){

    if($(slot).hasClass("occupied")){

        let remove =
        confirm(
            "Do You Want To Unbook This Slot?"
        );

        if(remove){

            unbookSlot(slot);

        }

    }

    else{

        let hours = prompt(
            "Enter Parking Hours"
        );

        if(hours == null || hours == ""){

            return;

        }

        let fee = hours * 20;

        let currentTime =
        new Date();

        let endTime =
        new Date(
            currentTime.getTime() +
            hours * 60 * 60 * 1000
        );

        let finalTime =
        endTime.toLocaleTimeString();

        currentSlot = slot;

        $("#feeText").html(
            "Parking Fee : ₹" + fee
        );

        $(currentSlot).attr(
            "data-fee",
            fee
        );

        $(currentSlot).attr(
            "data-time",
            finalTime
        );

        $("#paymentBox").fadeIn();

    }

}

function completePayment(){

    let fee =
    $(currentSlot).attr("data-fee");

    let time =
    $(currentSlot).attr("data-time");

    let slotNumber =
    $(currentSlot).attr("data-slot");

    $(currentSlot)
    .removeClass("available");

    $(currentSlot)
    .addClass("occupied");

    $(currentSlot).html(

        "🚗" +

        "<span>P" + slotNumber + " Booked</span>" +

        "<small>₹" + fee + "</small>" +

        "<small>Free At " + time + "</small>"

    );

    available--;

    booked++;

    $("#availableText").html(
        "Available Slots : " + available
    );

    $("#bookedText").html(
        "Booked Slots : " + booked
    );

    $("#paymentBox").fadeOut();

    alert(
        "🙏 Thanks For Booking"
    );

    setTimeout(function(){

        $("#notification").fadeIn();

        setTimeout(function(){

            $("#notification").fadeOut();

        },5000);

    },5000);

}

function unbookSlot(slot){

    let slotNumber =
    $(slot).attr("data-slot");

    $(slot)
    .removeClass("occupied");

    $(slot)
    .addClass("available");

    $(slot).html(
        "P" + slotNumber
    );

    available++;

    booked--;

    $("#availableText").html(
        "Available Slots : " + available
    );

    $("#bookedText").html(
        "Booked Slots : " + booked
    );

    alert(
        "✅ Slot Unbooked Successfully"
    );

}